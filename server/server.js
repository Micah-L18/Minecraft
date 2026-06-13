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

const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 25565;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DAY_LEN = 480; // seconds per full day — must match the client (src/main.js)
const TICK_MS = 66; // ~15 Hz transform broadcast
const TIME_EVERY = 20; // broadcast authoritative time every N ticks (~1.3 s)
const MAX_FRAME = 4 * 1024 * 1024; // reject absurd client frame lengths
const MAX_NAME = 16;
const MAX_CHAT = 200;
const MAX_ROOM = 24;

// ---------------------------------------------------------------------------
// Rooms / players
// ---------------------------------------------------------------------------

const rooms = new Map(); // code -> { seed, edits: Map<"x,y,z",id>, players: Map<id,player>, time }
let nextId = 1;

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = {
      seed: (Math.random() * 0x7fffffff) | 0,
      edits: new Map(),
      players: new Map(),
      time: 0.1, // matches the client's initial dayTime
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
  send(socket, { t: 'welcome', id, seed: room.seed, time: room.time, edits, players });

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
      if (p.moved) {
        list.push({ id: p.id, pos: p.pos, yaw: p.yaw, pitch: p.pitch });
        p.moved = false;
      }
    }
    if (list.length) broadcast(room, { t: 'moves', list });

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
