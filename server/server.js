// Voxelcraft multiplayer server — pure Node.js, ZERO dependencies.
//
// Hand-rolled WebSocket (RFC 6455): HTTP upgrade handshake + frame codec using
// only the `http` and `crypto` built-ins. Hosts many independent rooms keyed by
// a room code; each room owns a seed, an authoritative edit log, the connected
// players and the day/night time. Clients regenerate terrain locally from the
// shared seed, so only seed + edits + transforms cross the wire.
//
//   node server/server.js          (listens on PORT, default 25565)
//   PORT=25565 node server/server.js
//
// Rooms live in memory for the process lifetime only; restarting wipes them.

import http from 'node:http';
import crypto from 'node:crypto';
import { World } from '../src/world.js';
import { mulberry32 } from '../src/noise.js';
import * as Mobs from '../src/mobs.js';

const PORT = parseInt(process.env.PORT, 10) || 25565;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DAY_LEN = 480; // seconds per full day — must match the client (src/main.js)
const TICK_MS = 66; // ~15 Hz transform broadcast
const TIME_EVERY = 20; // broadcast authoritative time every N ticks (~1.3 s)
const MAX_FRAME = 4 * 1024 * 1024; // reject absurd client frame lengths
const MAX_NAME = 16;
const MAX_CHAT = 200;
const MAX_ROOM = 24;
const MAX_HP = 20;
const RESPAWN_TICKS = 15; // ~1s of invulnerability after death
const ATTACK_MIN_TICKS = 5; // server-enforced floor between sword swings
// Server-authoritative sword stats (never trust client-sent numbers).
const SWORD = { dmg: 6, range: 3.6, cone: 0.55, knock: 8 };
const MOB_POLICY = { cap: 10, rate: 0.55, minR: 14, maxR: 32 };
const DESPAWN_R = 80;

const r2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Rooms / players
// ---------------------------------------------------------------------------

const rooms = new Map(); // code -> { seed, edits: Map<"x,y,z",id>, players: Map<id,player>, time }
let nextId = 1;

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    const seed = (Math.random() * 0x7fffffff) | 0;
    room = {
      seed,
      edits: new Map(),
      players: new Map(),
      time: 0.1, // matches the client's initial dayTime
      // Mob simulation state (server is authoritative in multiplayer). The
      // World is only used for heightAt-based footing/LOS — no chunks stored.
      world: new World(seed),
      mobs: [],
      hazards: [],
      projectiles: [],
      nextMobId: 1,
      rng: mulberry32((seed ^ 0x9e3779b9) >>> 0),
    };
    rooms.set(code, room);
  }
  return room;
}

function sanitizeName(name) {
  let s = typeof name === 'string' ? name : '';
  s = s.replace(/[\x00-\x1f]/g, '').trim().slice(0, MAX_NAME);
  return s || 'Player' + nextId;
}

function sanitizeRoom(code) {
  let s = typeof code === 'string' ? code : '';
  s = s.replace(/[^A-Za-z0-9_-]/g, '').slice(0, MAX_ROOM);
  return s || 'lobby';
}

// ---------------------------------------------------------------------------
// WebSocket framing
// ---------------------------------------------------------------------------

function acceptKey(key) {
  return crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
}

// Encode a server->client text frame (never masked).
function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeControl(opcode, payload = Buffer.alloc(0)) {
  // Control frames are short; length always < 126 here.
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

function send(sock, obj) {
  if (sock.writable) sock.write(encodeFrame(JSON.stringify(obj)));
}

// ---------------------------------------------------------------------------
// HTTP + upgrade
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Voxelcraft WS server — connect a game client via ws://');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
  );

  socket.id = 0;
  socket.room = null;
  socket.alive = true;
  let buf = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // Parse as many complete frames as are buffered.
    while (true) {
      if (buf.length < 2) break;
      const b0 = buf[0];
      const b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buf.length < offset + 2) break;
        len = buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) break;
        const big = buf.readBigUInt64BE(offset);
        if (big > BigInt(MAX_FRAME)) {
          socket.destroy();
          return;
        }
        len = Number(big);
        offset += 8;
      }
      if (len > MAX_FRAME || !masked) {
        // Clients MUST mask; oversize or unmasked frame is a protocol error.
        socket.destroy();
        return;
      }
      if (buf.length < offset + 4 + len) break; // wait for full frame (mask + payload)

      const mask = buf.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i & 3];
      offset += len;
      buf = buf.subarray(offset); // consume this frame

      socket.alive = true;
      if (opcode === 0x8) {
        // close
        if (socket.writable) socket.write(encodeControl(0x8));
        socket.end();
        return;
      } else if (opcode === 0x9) {
        // ping -> pong
        if (socket.writable) socket.write(encodeControl(0xa, payload));
      } else if (opcode === 0xa) {
        // pong — liveness already marked above
      } else if (opcode === 0x1) {
        let msg;
        try {
          msg = JSON.parse(payload.toString('utf8'));
        } catch {
          continue; // ignore malformed
        }
        handleMessage(socket, msg);
      }
      // continuation/binary frames are not used by this protocol — ignore
    }
  });

  const cleanup = () => leave(socket);
  socket.on('close', cleanup);
  socket.on('error', cleanup);
  socket.on('end', cleanup);
});

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function handleMessage(socket, msg) {
  switch (msg && msg.t) {
    case 'hello':
      return onHello(socket, msg);
    case 'edit':
      return onEdit(socket, msg);
    case 'move':
      return onMove(socket, msg);
    case 'chat':
      return onChat(socket, msg);
    case 'attack':
      return onAttack(socket, msg);
    case 'shake':
      return onShake(socket, msg);
  }
}

function onHello(socket, msg) {
  if (socket.id) return; // already joined
  const code = sanitizeRoom(msg.room);
  const room = getRoom(code);
  const id = nextId++;
  const player = {
    id,
    name: sanitizeName(msg.name),
    pos: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    socket,
    moved: true,
    hp: MAX_HP,
    deadTicks: 0,
    lastAttackTick: 0,
  };
  socket.id = id;
  socket.room = code;
  room.players.set(id, player);

  // Late-join snapshot: seed + full edit log + current time + other players.
  const edits = [];
  for (const [k, v] of room.edits) {
    const [x, y, z] = k.split(',');
    edits.push([+x, +y, +z, v]);
  }
  const players = [];
  for (const p of room.players.values()) {
    if (p.id !== id) players.push({ id: p.id, name: p.name, pos: p.pos, yaw: p.yaw, pitch: p.pitch });
  }
  send(socket, {
    t: 'welcome', id, seed: room.seed, time: room.time, edits, players,
    hp: player.hp,
    mobs: room.mobs.map(serializeMob),
    hazards: room.hazards.map(serializeHaz),
  });

  broadcast(room, { t: 'join', id, name: player.name, pos: player.pos, yaw: player.yaw, pitch: player.pitch }, id);
  console.log(`[${code}] ${player.name} joined (id ${id}); ${room.players.size} online`);
}

function onEdit(socket, msg) {
  const room = rooms.get(socket.room);
  if (!room || !socket.id) return;
  const x = msg.x | 0,
    y = msg.y | 0,
    z = msg.z | 0,
    id = msg.id | 0;
  room.edits.set(x + ',' + y + ',' + z, id);
  broadcast(room, { t: 'edit', x, y, z, id }, socket.id); // others only; sender already applied
}

function onMove(socket, msg) {
  const room = rooms.get(socket.room);
  if (!room || !socket.id) return;
  const p = room.players.get(socket.id);
  if (!p || !Array.isArray(msg.pos) || msg.pos.length !== 3) return;
  p.pos = [+msg.pos[0], +msg.pos[1], +msg.pos[2]];
  p.yaw = +msg.yaw || 0;
  p.pitch = +msg.pitch || 0;
  p.moved = true;
}

function onChat(socket, msg) {
  const room = rooms.get(socket.room);
  if (!room || !socket.id) return;
  const p = room.players.get(socket.id);
  if (!p) return;
  let text = typeof msg.text === 'string' ? msg.text : '';
  text = text.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, MAX_CHAT);
  if (!text) return;
  broadcast(room, { t: 'chat', id: p.id, name: p.name, text }); // all, incl. sender
}

// Sword swing intent: validate range/cone against this room's mobs using the
// player's last-reported transform, then apply authoritative damage.
function onAttack(socket, msg) {
  const room = rooms.get(socket.room);
  if (!room || !socket.id) return;
  const p = room.players.get(socket.id);
  if (!p || p.hp <= 0 || !Array.isArray(msg.dir) || msg.dir.length !== 3) return;
  if (tickCount - p.lastAttackTick < ATTACK_MIN_TICKS) return; // rate limit
  p.lastAttackTick = tickCount;

  const eye = [p.pos[0], p.pos[1] + 1.62, p.pos[2]];
  let d = [+msg.dir[0] || 0, +msg.dir[1] || 0, +msg.dir[2] || 0];
  const dl = Math.hypot(d[0], d[1], d[2]) || 1;
  d = [d[0] / dl, d[1] / dl, d[2] / dl];
  const m = Mobs.pickAttackTarget(room.mobs, eye, d, SWORD);
  if (!m) return;
  const dx = m.pos[0] - eye[0], dz = m.pos[2] - eye[2];
  const hl = Math.hypot(dx, dz) || 1;
  const knock = [(dx / hl) * SWORD.knock, 4, (dz / hl) * SWORD.knock];
  const res = Mobs.hurtMob(m, SWORD.dmg, knock, { rng: room.rng, nextId: () => room.nextMobId++ });
  if (res.died) {
    const i = room.mobs.indexOf(m);
    if (i >= 0) room.mobs.splice(i, 1);
  }
  for (const c of res.spawned) room.mobs.push(c);
}

// "I shook off the Gloamwing." Only the latched client can measure the turn
// speed, so the server trusts the report and detaches that player's mob.
function onShake(socket, msg) {
  const room = rooms.get(socket.room);
  if (!room || !socket.id) return;
  for (const m of room.mobs) {
    if (m.latchedTo === socket.id) {
      m.latchedTo = -1;
      m.state = 'flee';
      m.abilityCd = Math.max(m.abilityCd, 2.5);
      m.vel[1] = 6;
    }
  }
}

// Compact wire forms (rounded to keep per-tick payloads small).
function serializeMob(m) {
  return {
    id: m.id, type: m.type,
    pos: [r2(m.pos[0]), r2(m.pos[1]), r2(m.pos[2])],
    yaw: r2(m.yaw), hp: m.hp, maxHp: m.maxHp, scale: m.scale, gen: m.gen,
    latchedTo: m.latchedTo, anim: r2(m.anim), flags: { observed: !!m.flags.observed },
  };
}
function serializeProj(p) {
  return { id: p.id, pos: [r2(p.pos[0]), r2(p.pos[1]), r2(p.pos[2])] };
}
function serializeHaz(h) {
  return { id: h.id, x: r2(h.x), y: r2(h.y), z: r2(h.z), r: h.r, ttl: r2(h.ttl) };
}

// Apply a sim event to its target player: deal damage, notify, handle death.
function applyMobEvent(room, e) {
  if (e.kind !== 'damage') return; // latch/unlatch are read from mob.latchedTo
  const p = room.players.get(e.playerId);
  if (!p || p.hp <= 0 || p.deadTicks > 0) return;
  p.hp = Math.max(0, p.hp - e.amount);
  send(p.socket, { t: 'hurt', hp: p.hp, amount: e.amount, knock: e.knock || [0, 0, 0] });
  if (p.hp <= 0) {
    send(p.socket, { t: 'death' });
    p.hp = MAX_HP;       // ready for the client's local respawn
    p.deadTicks = RESPAWN_TICKS; // brief grace so mobs don't instantly re-hit
  }
}

function leave(socket) {
  if (!socket.id || !socket.room) return;
  const room = rooms.get(socket.room);
  const id = socket.id;
  socket.id = 0;
  if (!room) return;
  const p = room.players.get(id);
  room.players.delete(id);
  if (p) {
    broadcast(room, { t: 'leave', id });
    console.log(`[${socket.room}] ${p.name} left (id ${id}); ${room.players.size} online`);
  }
}

function broadcast(room, obj, exceptId) {
  const data = encodeFrame(JSON.stringify(obj));
  for (const p of room.players.values()) {
    if (p.id === exceptId) continue;
    if (p.socket.writable) p.socket.write(data);
  }
}

// ---------------------------------------------------------------------------
// Tick: batched transforms + authoritative day/night time + keepalive
// ---------------------------------------------------------------------------

let tickCount = 0;
setInterval(() => {
  tickCount++;
  const sendTime = tickCount % TIME_EVERY === 0;
  for (const room of rooms.values()) {
    if (room.players.size === 0) continue;
    const list = [];
    for (const p of room.players.values()) {
      if (p.deadTicks > 0) p.deadTicks--;
      if (p.moved) {
        list.push({ id: p.id, pos: p.pos, yaw: p.yaw, pitch: p.pitch });
        p.moved = false;
      }
    }
    if (list.length) broadcast(room, { t: 'moves', list });

    // Authoritative mob simulation: spawn, despawn, step, broadcast.
    const observers = [];
    for (const p of room.players.values()) {
      observers.push({
        id: p.id, pos: p.pos, eye: [p.pos[0], p.pos[1] + 1.62, p.pos[2]],
        yaw: p.yaw, pitch: p.pitch, dir: Mobs.dirFromYawPitch(p.yaw, p.pitch),
        hp: p.hp, alive: p.hp > 0 && p.deadTicks === 0,
      });
    }
    const ctx = {
      dt: TICK_MS / 1000, world: room.world, observers, dayTime: room.time,
      rng: room.rng, nextId: () => room.nextMobId++,
    };
    Mobs.maybeSpawn(room.mobs, ctx, MOB_POLICY);
    Mobs.despawnFar(room.mobs, observers, DESPAWN_R);
    const r = Mobs.stepMobs(room.mobs, room.hazards, room.projectiles, ctx);
    for (const e of r.events) applyMobEvent(room, e);
    broadcast(room, {
      t: 'mobs',
      list: room.mobs.map(serializeMob),
      proj: room.projectiles.map(serializeProj),
    });
    if (r.hazardsChanged) broadcast(room, { t: 'hazards', list: room.hazards.map(serializeHaz) });

    room.time = (room.time + TICK_MS / 1000 / DAY_LEN) % 1;
    if (sendTime) broadcast(room, { t: 'time', time: room.time });
  }
}, TICK_MS);

// Keepalive ping every ~20 s; drop sockets that have gone silent.
setInterval(() => {
  for (const room of rooms.values()) {
    for (const p of room.players.values()) {
      const s = p.socket;
      if (!s.alive) {
        s.destroy();
        continue;
      }
      s.alive = false;
      if (s.writable) s.write(encodeControl(0x9));
    }
  }
}, 20000);

server.listen(PORT, () => {
  console.log(`Voxelcraft multiplayer server listening on :${PORT}`);
  console.log(`Connect: index.html?server=ws://localhost:${PORT}&room=lobby&name=Steve`);
});
