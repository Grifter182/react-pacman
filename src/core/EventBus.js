/**
 * Minimal synchronous event bus shared by every engine module.
 * Modules must never import each other directly for cross-domain signalling —
 * they publish and subscribe here. This keeps subsystem ownership clean.
 */
export class EventBus {
  constructor() {
    this._handlers = new Map();
  }

  on(type, fn) {
    let set = this._handlers.get(type);
    if (!set) { set = new Set(); this._handlers.set(type, set); }
    set.add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => { off(); fn(payload); });
    return off;
  }

  off(type, fn) {
    const set = this._handlers.get(type);
    if (set) set.delete(fn);
  }

  emit(type, payload) {
    const set = this._handlers.get(type);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch (err) { console.error(`[EventBus] handler for "${type}" threw`, err); }
    }
  }

  clear() { this._handlers.clear(); }
}
