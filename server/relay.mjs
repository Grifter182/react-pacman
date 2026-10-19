#!/usr/bin/env node
/**
 * OWNER: netcode agent.
 *
 * Operation Blackout multiplayer relay.
 *
 *   node server/relay.mjs [--port 8787] [--host 0.0.0.0] [--static dist] [--idle 45000]
 *
 * One process does two jobs:
 *   - a WebSocket endpoint at /net that groups clients into rooms, rebroadcasts
 *     their state as 20 Hz snapshots, validates hit claims and keeps the
 *     authoritative kill/death tally;
 *   - a static file server for the built game (`npx vite build` -> dist/), so
 *     a single port is all a host needs to open. Visiting `/` redirects to
 *     `/?online=1`, which is what turns the client's netcode on.
 *
 * ZERO DEPENDENCIES, ON PURPOSE. The project allows `three` and
 * `three-mesh-bvh` and nothing else, so the WebSocket layer (RFC 6455:
 * handshake, framing, masking, ping/pong, close) is implemented here on
 * `node:http` + `node:crypto`. It supports exactly what the game sends — text
 * frames, fragmented or not, up to 64 KiB — and closes the socket on anything
 * else.
 *
 * The wire protocol is documented in src/net/Protocol.js, which this file
 * imports unchanged.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROTOCOL_VERSION, TICK_HZ, DEFAULT_PORT, NET_PATH, MAX_PLAYERS_PER_ROOM,
  MAX_HIT_DAMAGE, sanitizeName, sanitizeRoom, isVec3,
} from '../src/net/Protocol.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(arg('port', process.env.PORT || String(DEFAULT_PORT)), 10);
const HOST = arg('host', process.env.HOST || '0.0.0.0');
const STATIC_DIR = path.resolve(ROOT, arg('static', 'dist'));
const QUIET = argv.includes('--quiet');

const MAX_FRAME = 64 * 1024;
// Generous on purpose: a client compiling shaders or baking textures on a slow
// machine can stall its main thread for many seconds without having gone.
const IDLE_TIMEOUT_MS = parseInt(arg('idle', '45000'), 10);
const HIT_RATE_PER_SEC = 30;        // fastest weapon is ~15 rps; pellets double it
const MAX_HIT_RANGE = 450;          // metres; the client traces to 400

const log = (...a) => { if (!QUIET) console.log(new Date().toISOString().slice(11, 19), ...a); };

/* ============================================================== WebSocket */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Minimal RFC 6455 server-side connection: text frames in, text frames out. */
class Socket {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.frag = null;            // pending fragments of a continued message
    this.open = true;
    this.onmessage = null;
    this.onclose = null;
    this.lastSeen = Date.now();

    sock.setNoDelay(true);
    sock.on('data', (d) => this._data(d));
    sock.on('close', () => this._closed());
    sock.on('error', () => this._closed());
  }

  send(obj) {
    if (!this.open) return;
    const payload = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
    this._frame(0x1, payload);
  }

  close(code = 1000) {
    if (!this.open) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code, 0);
    this._frame(0x8, p);
    this.open = false;
    this.sock.end();
  }

  _frame(opcode, payload) {
    const n = payload.length;
    let head;
    if (n < 126) {
      head = Buffer.from([0x80 | opcode, n]);
    } else if (n < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2);
    }
    try { this.sock.write(Buffer.concat([head, payload])); } catch { this._closed(); }
  }

  _data(chunk) {
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) return this.close(1009);
        len = Number(big); off = 10;
      }
      // Clients MUST mask (RFC 6455 5.1); an unmasked client frame is a protocol error.
      if (!masked) return this.close(1002);
      if (len > MAX_FRAME) return this.close(1009);
      if (this.buf.length < off + 4 + len) return;

      const mask = this.buf.subarray(off, off + 4);
      const data = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);

      if (opcode === 0x8) { this.close(1000); return; }
      if (opcode === 0x9) { this._frame(0xA, data); continue; }       // ping -> pong
      if (opcode === 0xA) continue;                                     // pong
      if (opcode === 0x1 || opcode === 0x0) {
        if (opcode === 0x1) this.frag = [data];
        else if (this.frag) this.frag.push(data);
        else return this.close(1002);
        const total = this.frag.reduce((s, b) => s + b.length, 0);
        if (total > MAX_FRAME) return this.close(1009);
        if (!fin) continue;
        const text = Buffer.concat(this.frag).toString('utf8');
        this.frag = null;
        let msg = null;
        try { msg = JSON.parse(text); } catch { /* ignore malformed */ }
        if (msg && typeof msg === 'object' && this.onmessage) this.onmessage(msg);
        continue;
      }
      return this.close(1003);                                          // binary: unsupported
    }
  }

  _closed() {
    if (!this.sock.destroyed) this.sock.destroy();
    this.open = false;
    if (this._notified) return;
    this._notified = true;
    this.onclose?.();
  }
}

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

/* ================================================================== rooms */

const rooms = new Map();   // name -> Room
let nextId = 1;

class Room {
  constructor(name) {
    this.name = name;
    this.clients = new Map();  // id -> Client
  }

  broadcast(msg, except = null) {
    const text = JSON.stringify(msg);
    for (const c of this.clients.values()) if (c !== except) c.ws.send(text);
  }

  uniqueName(base) {
    const taken = new Set([...this.clients.values()].map((c) => c.name));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 100; i++) {
      const n = `${base.slice(0, 10)}${i}`;
      if (!taken.has(n)) return n;
    }
    return `OP${nextId}`;
  }

  score() {
    return [...this.clients.values()].map((c) => ({ id: c.id, k: c.kills, d: c.deaths }));
  }

  snapshot() {
    const ps = [];
    for (const c of this.clients.values()) if (c.state) ps.push({ id: c.id, ...c.state });
    return { t: 'snap', s: Date.now(), ps };
  }
}

/** Whitelist the state frame: nothing a client sends is relayed blind. */
function cleanState(m) {
  if (!isVec3(m.p)) return null;
  return {
    p: m.p,
    v: isVec3(m.v) ? m.v : [0, 0, 0],
    y: Number.isFinite(m.y) ? m.y : 0,
    pi: Number.isFinite(m.pi) ? Math.max(-1.6, Math.min(1.6, m.pi)) : 0,
    s: Number.isInteger(m.s) ? m.s & 3 : 0,
    a: !!m.a,
    w: typeof m.w === 'string' ? m.w.slice(0, 16) : 'rifle',
    ads: !!m.ads,
  };
}

function handleConnection(ws) {
  let client = null;
  let room = null;

  ws.onmessage = (m) => {
    if (!client) {
      if (m.t !== 'hello') return;
      if (m.v !== PROTOCOL_VERSION) {
        ws.send({ t: 'error', reason: `protocol mismatch: relay v${PROTOCOL_VERSION}, client v${m.v}` });
        return ws.close(4000);
      }
      const roomName = sanitizeRoom(m.room);
      room = rooms.get(roomName);
      if (!room) { room = new Room(roomName); rooms.set(roomName, room); }
      if (room.clients.size >= MAX_PLAYERS_PER_ROOM) {
        ws.send({ t: 'error', reason: `room "${roomName}" is full` });
        return ws.close(4001);
      }
      const id = nextId++;
      const name = room.uniqueName(sanitizeName(m.name) || `OPERATOR${id}`);
      client = { id, name, ws, state: null, kills: 0, deaths: 0, hitBudget: HIT_RATE_PER_SEC, lastHitRefill: Date.now() };
      ws.send({
        t: 'welcome', id, name, room: roomName, hz: TICK_HZ,
        players: [...room.clients.values()].map((c) => ({ id: c.id, name: c.name, k: c.kills, d: c.deaths })),
      });
      room.clients.set(id, client);
      room.broadcast({ t: 'join', id, name }, client);
      log(`+ ${name}#${id} joined "${roomName}" (${room.clients.size})`);
      return;
    }

    switch (m.t) {
      case 'st': {
        const s = cleanState(m);
        if (s) client.state = s;
        break;
      }
      case 'fire': {
        if (!isVec3(m.o) || !isVec3(m.d)) break;
        room.broadcast({
          t: 'fire', id: client.id, o: m.o, d: m.d,
          e: isVec3(m.e) ? m.e : null, n: isVec3(m.n) ? m.n : null,
          m: typeof m.m === 'string' ? m.m.slice(0, 24) : null,
          w: typeof m.w === 'string' ? m.w.slice(0, 16) : 'rifle',
        }, client);
        break;
      }
      case 'hit': {
        const target = room.clients.get(m.to);
        if (!target || target === client) break;
        if (!client.state?.a || !target.state?.a) break;      // the dead neither shoot nor bleed
        const dmg = Number(m.dmg);
        if (!Number.isFinite(dmg) || dmg <= 0 || dmg > MAX_HIT_DAMAGE) break;
        // Token bucket, so a modified client cannot unload a magazine in one frame.
        const now = Date.now();
        client.hitBudget = Math.min(HIT_RATE_PER_SEC,
          client.hitBudget + (now - client.lastHitRefill) / 1000 * HIT_RATE_PER_SEC);
        client.lastHitRefill = now;
        if (client.hitBudget < 1) break;
        client.hitBudget -= 1;
        const a = client.state.p, b = target.state.p;
        if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > MAX_HIT_RANGE) break;
        target.ws.send({
          t: 'hit', by: client.id, dmg, hs: !!m.hs,
          limb: typeof m.limb === 'string' ? m.limb.slice(0, 12) : 'chest',
          o: [a[0], a[1] + 1.6, a[2]],
        });
        break;
      }
      case 'died': {
        client.deaths++;
        const killer = room.clients.get(m.by);
        if (killer && killer !== client) killer.kills++;
        if (client.state) client.state.a = false;
        room.broadcast({
          t: 'kill', killer: killer && killer !== client ? killer.id : null,
          victim: client.id, hs: !!m.hs, score: room.score(),
        });
        log(`x ${killer ? killer.name : 'world'} -> ${client.name} in "${room.name}"`);
        break;
      }
      case 'ping':
        ws.send({ t: 'pong', c: m.c, s: Date.now() });
        break;
      default:
        break;
    }
  };

  ws.onclose = () => {
    if (!client || !room) return;
    room.clients.delete(client.id);
    room.broadcast({ t: 'leave', id: client.id });
    log(`- ${client.name}#${client.id} left "${room.name}" (${room.clients.size})`);
    if (room.clients.size === 0) rooms.delete(room.name);
  };
}

/* ========================================================= snapshot loop */

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.clients.size < 2) continue;      // nobody to tell
    room.broadcast(room.snapshot());
  }
}, 1000 / TICK_HZ);

// Drop half-open sockets: a client that vanished without a FIN would
// otherwise sit in the room as a frozen statue forever.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const c of room.clients.values()) {
      if (now - c.ws.lastSeen > IDLE_TIMEOUT_MS) c.ws.close(1001);
    }
  }
}, 5000);

/* ================================================================= static */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.hdr': 'application/octet-stream',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === `${NET_PATH}/info`) {
    const list = [...rooms.values()].map((r) => ({ room: r.name, players: r.clients.size }));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ v: PROTOCOL_VERSION, rooms: list }));
  }

  // The relay is the multiplayer host, so landing on it means "play online".
  if (url.pathname === '/' && !url.searchParams.has('online')) {
    url.searchParams.set('online', '1');
    res.writeHead(302, { location: `/${url.search}` });
    return res.end();
  }

  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(STATIC_DIR, `.${rel}`);
  if (!file.startsWith(STATIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      if (!fs.existsSync(path.join(STATIC_DIR, 'index.html'))) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('No build found. Run `npx vite build` first, or use `npm run dev` with this relay running.\n');
      }
      res.writeHead(404); return res.end();
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': rel.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

/* ================================================================= server */

const server = http.createServer(serveStatic);

server.on('upgrade', (req, sock) => {
  const url = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== NET_PATH || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  sock.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '', '',
  ].join('\r\n'));
  handleConnection(new Socket(sock));
});

server.listen(PORT, HOST, () => {
  log(`Operation Blackout relay on http://${HOST}:${PORT}  (ws ${NET_PATH}, static ${path.relative(ROOT, STATIC_DIR) || '.'})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
