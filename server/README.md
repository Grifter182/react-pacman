# Online play

Operation Blackout supports online matches between several people through a
small relay server (`server/relay.mjs`). The relay has no dependencies beyond
Node 18+. It speaks WebSocket itself and also serves the built game, so one
port is all a host needs to open.

## Host a game

```bash
npm install
npm run serve            # vite build, then the relay on http://0.0.0.0:8787
```

Everyone then opens `http://<host-address>:8787/`. Visiting the root
redirects to `/?online=1` and joins the `public` room.

To play across the internet, forward TCP port 8787 on the host, or put the
relay behind any HTTPS reverse proxy that passes WebSocket upgrades on `/net`.
Under HTTPS the client connects with `wss://` automatically.

Relay options: `--port 8787`, `--host 0.0.0.0`, `--static dist`, and
`--idle 45000`, which sets how many ms of silence pass before a client is
dropped. `PORT` and `HOST` environment variables also work.
`GET /net/info` lists the open rooms and how many players are in each.

## Develop with it

```bash
npm run relay            # terminal 1: relay on :8787
npm run dev              # terminal 2: vite on :5173, proxies /net to the relay
```

Then open `http://localhost:5173/?online=1` in two windows.

## URL parameters

| Parameter          | Effect                                                         |
| ------------------ | -------------------------------------------------------------- |
| `online=1`         | Connect to the relay at this page's origin (`/net`)            |
| `online=0`         | Force single-player, even on the relay's own address           |
| `server=ws://h:p/net` | Connect to a specific relay (implies `online=1`)            |
| `room=alpha`       | Join a named room (default `public`, up to 16 players each)    |
| `name=GHOST`       | Callsign: A–Z, 0–9, `-`, `_`, max 12 characters (default random) |
| `bots=N`           | Keep N local bots. Online play defaults to none (see below)    |

Hold **Tab** during an online match to see the relay's kill/death board under
the minimap.

## How it works

- **Movement** is sent by each client at 20 Hz. The relay rebroadcasts all
  states as one snapshot per room per tick. Other players are drawn 110 ms in
  the past, interpolated between snapshots, with brief extrapolation if a
  packet is late.
- **Hits** are decided by the shooter, against the bodies as they appeared
  on the shooter's screen. This is the usual "favour the shooter" lag
  compensation. The relay rate-limits, range-checks and caps every hit claim
  before forwarding it to the victim only.
- **Deaths** are reported by the victim. The relay keeps the authoritative
  kill/death tally and broadcasts every kill, so all killfeeds agree.
- Remote players use the same procedural soldier, hitboxes and ragdoll as the
  AI squad, so they are exactly as large and as hittable as a bot.

The wire protocol is documented in `src/net/Protocol.js`, and the client is in
`src/net/NetModule.js`.

## Limitations

- **Free-for-all only.** Every other human is hostile. Each player's own HUD
  team score counts their kills; the Tab board is the shared truth.
- **No shared bots.** The AI squad is simulated separately on each client, so
  shared bots would be different soldiers on every screen. Online rooms are
  humans only unless `?bots=N` is given, and then those bots are private to
  that player.
- **Match clock and score limit are per client.** Each player's round
  timer starts when they join.
- **Trust model.** Clients are authoritative for their own movement and
  hits. The relay rejects implausible claims, but it does not re-simulate the
  game, so it is meant for playing with friends, not for public competitive
  servers.

## Verifying

```bash
npx vite build
PW_CHROMIUM=/opt/pw-browsers/chromium node tools/net-probe.mjs --out shots/net
```

The probe boots the relay and two headless clients in one room, then checks
presence, interpolation accuracy, damage, kill credit, both killfeeds, ragdoll,
respawn, the session panel and leaving. It exits non-zero if any check fails.
