// Client networking: a thin wrapper over the browser's native WebSocket.
// The browser handles all WS framing/masking, so this just speaks the JSON
// protocol and exposes a tiny event bus to main.js.
//
// Events (via on(type, cb)): 'status', 'welcome', 'join', 'moves', 'leave',
// 'edit', 'chat', 'time'. Each callback receives the parsed message object.

const MOVE_INTERVAL = 66; // ms between transform sends (~15 Hz)

export class Net {
  constructor(url, room, name) {
    this.url = url;
    this.room = room;
    this.name = name;
    this.ws = null;
    this.handlers = new Map();
    this.lastMove = 0;
  }

  on(type, cb) {
    this.handlers.set(type, cb);
    return this;
  }

  emit(type, msg) {
    const cb = this.handlers.get(type);
    if (cb) cb(msg);
  }

  connect() {
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.emit('status', { state: 'error', error: String(e) });
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.send({ t: 'hello', room: this.room, name: this.name });
      this.emit('status', { state: 'connected' });
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg && msg.t) this.emit(msg.t, msg);
    };
    ws.onclose = () => this.emit('status', { state: 'disconnected' });
    ws.onerror = () => this.emit('status', { state: 'error' });
  }

  get connected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  send(obj) {
    if (this.connected) this.ws.send(JSON.stringify(obj));
  }

  sendEdit(x, y, z, id) {
    this.send({ t: 'edit', x, y, z, id });
  }

  // Called every frame; self-throttles so we don't spam the socket.
  sendMove(pos, yaw, pitch) {
    const now = performance.now();
    if (now - this.lastMove < MOVE_INTERVAL) return;
    this.lastMove = now;
    this.send({ t: 'move', pos: [pos[0], pos[1], pos[2]], yaw, pitch });
  }

  sendChat(text) {
    this.send({ t: 'chat', text });
  }
}
