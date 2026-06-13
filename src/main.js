// Game bootstrap and main loop: chunk streaming, block interaction,
// day/night cycle and HUD.

import { mat4Perspective, viewMatrix } from './math.js';
import { buildAtlas, TILE, ATLAS_COLS } from './textures.js';
import { B, BLOCKS } from './blocks.js';
import { World, CX, CY, CZ, SEA } from './world.js';
import { buildChunkMesh } from './mesher.js';
import { Renderer } from './renderer.js';
import { Player } from './player.js';
import { Input } from './input.js';
import { raycast } from './raycast.js';
import { Net } from './net.js';

const GEN_R = 6;     // generate terrain within this chunk radius
const MESH_R = 5;    // mesh/draw within this radius (needs generated neighbors for AO)
const UNLOAD_R = 9;  // free memory beyond this radius
const DAY_LEN = 480; // seconds per full day/night cycle
const REACH = 6;
const MOUSE_SENS = 0.0023;

const canvas = document.getElementById('glcanvas');
const overlay = document.getElementById('overlay');
const debugEl = document.getElementById('debug');
const seedDisplay = document.getElementById('seed-display');
const seedInput = document.getElementById('seed-input');

const atlas = buildAtlas();
const renderer = new Renderer(canvas, atlas);
const input = new Input(canvas);
const player = new Player();

// Multiplayer is opted into with ?server=ws://host:port (&room=CODE&name=Steve).
// Single-player (no ?server=) keeps the original synchronous boot.
const params = new URLSearchParams(location.search);
const serverUrl = params.get('server');
const isMP = !!serverUrl;
let roomCode = (params.get('room') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
const playerName = (params.get('name') || '').slice(0, 16) || 'Player';
let net = null;
let myId = 0;
let ready = !isMP; // SP is ready at once; MP waits for the server `welcome`.

// Remote players, interpolated between ~15 Hz transform updates.
const remotePlayers = new Map(); // id -> { name, prev, next, tPrev, tNext, color, el, cur }
const AVATAR_COLORS = [
  [0.85, 0.32, 0.32], [0.32, 0.52, 0.85], [0.4, 0.75, 0.4], [0.85, 0.72, 0.3],
  [0.7, 0.42, 0.82], [0.4, 0.76, 0.82], [0.9, 0.55, 0.3], [0.6, 0.6, 0.62],
];
const HEAD_COLOR = [0.86, 0.72, 0.58];

// Seed: read ?seed=NNN from the URL for a reproducible map, else random.
function randomSeed() {
  return Math.floor(Math.random() * 0x7fffffff);
}
function urlSeed() {
  const raw = params.get('seed');
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n | 0 : null;
}

// Edits layered on top of procedural terrain. Empty in SP; in MP it holds the
// server edit log plus every local/remote edit, so they survive lazy chunk
// (re)generation and chunk unload -> reload.
const pendingEdits = new Map(); // "x,y,z" -> blockId

const world = new World(randomSeed());

// Generate a chunk, then stamp any pending edits that fall inside it before it
// gets meshed. In SP pendingEdits is empty, so this is just generateChunk.
function generateChunkWithEdits(cx, cz) {
  const c = world.generateChunk(cx, cz);
  if (pendingEdits.size) {
    for (const [k, id] of pendingEdits) {
      const [x, y, z] = k.split(',');
      if (Math.floor(+x / CX) === cx && Math.floor(+z / CZ) === cz) world.setBlock(+x, +y, +z, id);
    }
  }
  return c;
}

// Place the player on the first land column east of the origin, pre-generating
// the surrounding chunks so they don't fall through. Used on boot and on regen.
function spawn() {
  let spawnCX = 0;
  for (let i = 0; i < 64; i++) {
    if (world.heightAt(i * CX + 8, 8) > SEA + 1) {
      spawnCX = i;
      break;
    }
  }
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) generateChunkWithEdits(spawnCX + dx, dz);
  }
  player.pos = [spawnCX * CX + 8.5, world.surfaceY(spawnCX * CX + 8, 8) + 1.01, 8.5];
  player.vel = [0, 0, 0];
  player.fly = false;
  player.onGround = false;
  player.inWater = false;
}

// Build a fresh map: re-seed the world, free GPU buffers, respawn, and reflect
// the new seed in the address bar (for sharing) and the HUD. SP only.
function regenerate(seed = randomSeed()) {
  if (isMP) return; // the server owns the world online
  world.reset(seed);
  renderer.clearMeshes();
  spawn();
  history.replaceState(null, '', '?seed=' + world.seed);
  syncSeedUI();
}

function syncSeedUI() {
  if (seedDisplay) seedDisplay.textContent = world.seed;
  if (seedInput) seedInput.value = world.seed;
}

function bootSinglePlayer(seed) {
  world.reset(seed);
  spawn();
  history.replaceState(null, '', '?seed=' + world.seed);
  syncSeedUI();
}

const HOTBAR = [B.GRASS, B.DIRT, B.STONE, B.PLANKS, B.LOG, B.LEAVES, B.GLASS, B.SAND, B.COBBLE];
let selected = 0;
const slots = buildHotbarUI();
updateHotbarSel();

let dayTime = 0.1;
let breakCd = 0;
let placeCd = 0;
let target = null;
let fps = 60;
let debugVisible = true;
let debugTimer = 0;

overlay.addEventListener('click', () => canvas.requestPointerLock());
document.addEventListener('pointerlockchange', () => {
  overlay.classList.toggle('hidden', document.pointerLockElement === canvas);
});

// Overlay menu controls: clicks here must not bubble to the overlay's
// requestPointerLock handler (which would dismiss the menu).
const menuControls = document.getElementById('menu-controls');
if (menuControls) menuControls.addEventListener('click', (e) => e.stopPropagation());

const newWorldBtn = document.getElementById('new-world');
const loadSeedBtn = document.getElementById('load-seed');
function loadSeedFromInput() {
  const n = Number(seedInput.value);
  if (Number.isFinite(n) && seedInput.value.trim() !== '') regenerate(n | 0);
}
if (!isMP) {
  newWorldBtn?.addEventListener('click', () => regenerate());
  loadSeedBtn?.addEventListener('click', loadSeedFromInput);
  seedInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadSeedFromInput();
  });
} else {
  // The server owns the world online — disable the single-player map controls.
  if (newWorldBtn) newWorldBtn.disabled = true;
  if (loadSeedBtn) loadSeedBtn.disabled = true;
  if (seedInput) seedInput.readOnly = true;
}

// Multiplayer connect form: builds a ?server=&room=&name= URL and reloads.
const mpServer = document.getElementById('mp-server');
const mpRoom = document.getElementById('mp-room');
const mpName = document.getElementById('mp-name');
if (mpServer) mpServer.value = serverUrl || 'ws://' + (location.hostname || 'localhost') + ':25565';
if (mpRoom) mpRoom.value = roomCode;
if (mpName && params.get('name')) mpName.value = params.get('name');
document.getElementById('mp-join')?.addEventListener('click', () => {
  const sv = (mpServer?.value || '').trim();
  if (!sv) return;
  const q = new URLSearchParams();
  q.set('server', sv);
  const rm = (mpRoom?.value || '').trim();
  const nm = (mpName?.value || '').trim();
  if (rm) q.set('room', rm);
  if (nm) q.set('name', nm);
  location.search = '?' + q.toString();
});

// HUD elements for multiplayer (nameplates, chat, status banner).
const nameplatesEl = document.getElementById('nameplates');
const chatLogEl = document.getElementById('chatlog');
const chatInputEl = document.getElementById('chatinput');
const netStatusEl = document.getElementById('netstatus');

// Chat input is captured manually (no real <input> focus) so opening it never
// drops pointer lock and pops the click-to-play overlay.
let chatOpen = false;
let chatDraft = '';
if (isMP) setupChat();

// Boot: connect in MP (the world spawns on `welcome`), else start SP at once.
if (isMP) setupNet();
else bootSinglePlayer(urlSeed() ?? randomSeed());

let last = performance.now();
requestAnimationFrame(function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05;

  const ev = input.consume();

  // Until the server `welcome` arrives in MP, paint a plain sky and wait.
  if (!ready) {
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    renderer.draw({
      proj: mat4Perspective((70 * Math.PI) / 180, aspect, 0.08, 480),
      view: viewMatrix([0, 0, 0], 0, 0),
      sun: 1,
      fogColor: [0.7, 0.82, 0.95],
      fogNear: 0,
      fogFar: 1,
      highlight: null,
    });
    return;
  }

  const active = input.locked && !chatOpen; // gameplay input enabled?
  if (active) {
    player.yaw -= ev.dx * MOUSE_SENS;
    player.pitch = Math.max(-1.55, Math.min(1.55, player.pitch - ev.dy * MOUSE_SENS));
  }
  if (!chatOpen) {
    if (ev.wheel) {
      selected = (((selected + ev.wheel) % HOTBAR.length) + HOTBAR.length) % HOTBAR.length;
      updateHotbarSel();
    }
    for (let i = 1; i <= HOTBAR.length; i++) {
      if (ev.pressed.has('Digit' + i)) {
        selected = i - 1;
        updateHotbarSel();
      }
    }
    if (ev.pressed.has('KeyF')) player.fly = !player.fly;
    if (!isMP && input.locked && ev.pressed.has('KeyN')) regenerate();
  }
  if (ev.pressed.has('F3')) {
    debugVisible = !debugVisible;
    debugEl.classList.toggle('hidden', !debugVisible);
    if (!debugVisible) debugEl.textContent = '';
  }

  if (active) player.update(dt, input, world);
  if (isMP && net) net.sendMove(player.pos, player.yaw, player.pitch);
  streamChunks();

  const eye = [player.pos[0], player.pos[1] + player.eyeH, player.pos[2]];
  const cp = Math.cos(player.pitch);
  const dir = [-Math.sin(player.yaw) * cp, Math.sin(player.pitch), -Math.cos(player.yaw) * cp];
  target = raycast(world, eye[0], eye[1], eye[2], dir[0], dir[1], dir[2], REACH);

  breakCd -= dt;
  placeCd -= dt;
  if (!input.buttons[0]) breakCd = 0;
  if (!input.buttons[2]) placeCd = 0;
  if (active && target) {
    if (ev.pressed.has('Mouse1')) {
      const i = HOTBAR.indexOf(target.id);
      if (i >= 0) {
        selected = i;
        updateHotbarSel();
      }
    }
    if (input.buttons[0] && breakCd <= 0 && target.id !== B.BEDROCK) {
      applyEdit(target.x, target.y, target.z, B.AIR);
      breakCd = 0.25;
    } else if (input.buttons[2] && placeCd <= 0) {
      const px = target.x + target.nx;
      const py = target.y + target.ny;
      const pz = target.z + target.nz;
      const cur = world.getBlock(px, py, pz);
      if ((cur === B.AIR || cur === B.WATER) && py >= 0 && py < CY && !intersectsPlayer(px, py, pz)) {
        applyEdit(px, py, pz, HOTBAR[selected]);
        placeCd = 0.25;
      }
    }
  }

  // Day/night cycle: t=0 sunrise, 0.25 noon, 0.5 sunset.
  dayTime = (dayTime + dt / DAY_LEN) % 1;
  const s = Math.sin(dayTime * Math.PI * 2);
  const daylight = Math.max(0, Math.min(1, s * 2.5 + 0.25));
  const sun = 0.25 + 0.75 * daylight;
  let sky = lerp3([0.04, 0.06, 0.12], [0.7, 0.82, 0.95], daylight);
  const dusk = Math.max(0, 1 - Math.abs(s) * 4) * Math.max(daylight, 0.2);
  sky = lerp3(sky, [0.93, 0.6, 0.38], dusk * 0.5);

  let fogNear = MESH_R * CX - 24;
  let fogFar = MESH_R * CX - 2;
  let fogColor = sky;
  if (world.getBlock(Math.floor(eye[0]), Math.floor(eye[1]), Math.floor(eye[2])) === B.WATER) {
    fogNear = 0;
    fogFar = 18;
    fogColor = lerp3([0, 0, 0], [0.1, 0.22, 0.45], sun);
  }

  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const proj = mat4Perspective((70 * Math.PI) / 180, aspect, 0.08, 480);
  const view = viewMatrix(eye, player.yaw, player.pitch);
  const players = isMP ? buildRemotePlayerList(now) : null;
  renderer.draw({
    proj,
    view,
    sun,
    fogColor,
    fogNear,
    fogFar,
    highlight: target ? [target.x, target.y, target.z] : null,
    players,
  });
  if (isMP) updateNameplates(proj, view);

  debugTimer -= dt;
  if (debugVisible && debugTimer <= 0) {
    debugTimer = 0.25;
    updateDebug();
  }
});

function applyEdit(x, y, z, id) {
  if (isMP) {
    pendingEdits.set(x + ',' + y + ',' + z, id);
    if (net) net.sendEdit(x, y, z, id);
  }
  for (const [cx, cz] of world.setBlock(x, y, z, id)) {
    const c = world.getChunk(cx, cz);
    if (c && c.meshed) remesh(cx, cz);
  }
}

// A remote player's edit: record it and apply locally without rebroadcasting.
// If the chunk isn't generated yet, the pendingEdits overlay applies it later.
function applyRemoteEdit(x, y, z, id) {
  pendingEdits.set(x + ',' + y + ',' + z, id);
  for (const [cx, cz] of world.setBlock(x, y, z, id)) {
    const c = world.getChunk(cx, cz);
    if (c && c.meshed) remesh(cx, cz);
  }
}

function remesh(cx, cz) {
  const c = world.getChunk(cx, cz);
  renderer.setChunkMesh(world.key(cx, cz), buildChunkMesh(world, cx, cz));
  c.dirty = false;
  c.meshed = true;
}

function neighborsReady(cx, cz) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (!world.getChunk(cx + dx, cz + dz)) return false;
    }
  }
  return true;
}

function streamChunks() {
  const pcx = Math.floor(player.pos[0] / CX);
  const pcz = Math.floor(player.pos[2] / CZ);

  const toGen = [];
  for (let dx = -GEN_R; dx <= GEN_R; dx++) {
    for (let dz = -GEN_R; dz <= GEN_R; dz++) {
      if (!world.getChunk(pcx + dx, pcz + dz)) toGen.push([dx * dx + dz * dz, pcx + dx, pcz + dz]);
    }
  }
  toGen.sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < Math.min(2, toGen.length); i++) generateChunkWithEdits(toGen[i][1], toGen[i][2]);

  const toMesh = [];
  for (let dx = -MESH_R; dx <= MESH_R; dx++) {
    for (let dz = -MESH_R; dz <= MESH_R; dz++) {
      const cx = pcx + dx;
      const cz = pcz + dz;
      const c = world.getChunk(cx, cz);
      if (c && (c.dirty || !c.meshed) && neighborsReady(cx, cz)) {
        toMesh.push([dx * dx + dz * dz, cx, cz]);
      }
    }
  }
  toMesh.sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < Math.min(2, toMesh.length); i++) remesh(toMesh[i][1], toMesh[i][2]);

  for (const [key, c] of world.chunks) {
    if (Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz)) > UNLOAD_R) {
      world.chunks.delete(key);
      renderer.removeChunk(key);
    }
  }
}

function intersectsPlayer(bx, by, bz) {
  const w = 0.3, h = 1.8;
  return (
    bx + 1 > player.pos[0] - w &&
    bx < player.pos[0] + w &&
    by + 1 > player.pos[1] &&
    by < player.pos[1] + h &&
    bz + 1 > player.pos[2] - w &&
    bz < player.pos[2] + w
  );
}

function lerp3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function buildHotbarUI() {
  const hb = document.getElementById('hotbar');
  return HOTBAR.map((id, i) => {
    const slot = document.createElement('div');
    slot.className = 'slot';
    const icon = document.createElement('canvas');
    icon.width = icon.height = 36;
    const g = icon.getContext('2d');
    g.imageSmoothingEnabled = false;
    const tile = BLOCKS[id].tiles.side;
    g.drawImage(
      atlas,
      (tile % ATLAS_COLS) * TILE,
      ((tile / ATLAS_COLS) | 0) * TILE,
      TILE,
      TILE,
      0,
      0,
      36,
      36
    );
    const num = document.createElement('span');
    num.textContent = i + 1;
    slot.append(icon, num);
    hb.appendChild(slot);
    return slot;
  });
}

function updateHotbarSel() {
  slots.forEach((slot, i) => slot.classList.toggle('selected', i === selected));
}

// --- Multiplayer ---------------------------------------------------------

function setupNet() {
  roomCode = roomCode || randomRoomCode();
  history.replaceState(
    null,
    '',
    '?server=' + encodeURIComponent(serverUrl) + '&room=' + roomCode + '&name=' + encodeURIComponent(playerName)
  );
  setNetStatus('Connecting…');
  net = new Net(serverUrl, roomCode, playerName);
  net.on('status', onStatus);
  net.on('welcome', onWelcome);
  net.on('join', (m) => addRemotePlayer(m));
  net.on('leave', (m) => removeRemotePlayer(m.id));
  net.on('moves', (m) => m.list.forEach(updateRemote));
  net.on('edit', (m) => applyRemoteEdit(m.x, m.y, m.z, m.id));
  net.on('chat', (m) => addChat(m.name, m.text));
  net.on('time', (m) => snapTime(m.time));
  net.connect();
}

function onStatus(m) {
  if (m.state === 'connected') setNetStatus('Joining…');
  else if (m.state === 'disconnected') setNetStatus('Disconnected — reload to rejoin');
  else if (m.state === 'error') setNetStatus('Connection error — check the server URL, then reload');
}

function onWelcome(m) {
  myId = m.id;
  world.reset(m.seed);
  renderer.clearMeshes();
  pendingEdits.clear();
  for (const [x, y, z, id] of m.edits) pendingEdits.set(x + ',' + y + ',' + z, id);
  spawn(); // generates spawn chunks through generateChunkWithEdits -> edits applied
  dayTime = m.time;
  clearRemotePlayers();
  for (const p of m.players) addRemotePlayer(p);
  syncSeedUI();
  ready = true;
  setNetStatus('');
}

function addRemotePlayer(p) {
  if (p.id === myId || remotePlayers.has(p.id)) return;
  const pose = { pos: (p.pos || [0, 0, 0]).slice(), yaw: p.yaw || 0 };
  const el = document.createElement('div');
  el.className = 'nameplate';
  el.textContent = p.name || 'Player';
  el.style.display = 'none';
  if (nameplatesEl) nameplatesEl.appendChild(el);
  const t = performance.now();
  remotePlayers.set(p.id, {
    name: p.name,
    prev: { pos: pose.pos.slice(), yaw: pose.yaw },
    next: { pos: pose.pos.slice(), yaw: pose.yaw },
    tPrev: t,
    tNext: t,
    color: AVATAR_COLORS[p.id % AVATAR_COLORS.length],
    el,
    cur: { pos: pose.pos.slice(), yaw: pose.yaw },
  });
}

function updateRemote(s) {
  if (s.id === myId) return;
  let rp = remotePlayers.get(s.id);
  if (!rp) {
    addRemotePlayer(s);
    rp = remotePlayers.get(s.id);
    if (!rp) return;
  }
  const t = performance.now();
  rp.prev = { pos: rp.cur.pos.slice(), yaw: rp.cur.yaw };
  rp.next = { pos: [s.pos[0], s.pos[1], s.pos[2]], yaw: s.yaw || 0 };
  rp.tPrev = t;
  rp.tNext = t + 66; // reach the new sample one tick later -> smooth
}

function removeRemotePlayer(id) {
  const rp = remotePlayers.get(id);
  if (!rp) return;
  if (rp.el && rp.el.parentNode) rp.el.parentNode.removeChild(rp.el);
  remotePlayers.delete(id);
}

function clearRemotePlayers() {
  for (const id of [...remotePlayers.keys()]) removeRemotePlayer(id);
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

function buildRemotePlayerList(now) {
  const list = [];
  for (const rp of remotePlayers.values()) {
    const span = Math.max(1, rp.tNext - rp.tPrev);
    const a = Math.min(1, (now - rp.tPrev) / span);
    const pos = [
      rp.prev.pos[0] + (rp.next.pos[0] - rp.prev.pos[0]) * a,
      rp.prev.pos[1] + (rp.next.pos[1] - rp.prev.pos[1]) * a,
      rp.prev.pos[2] + (rp.next.pos[2] - rp.prev.pos[2]) * a,
    ];
    rp.cur = { pos, yaw: lerpAngle(rp.prev.yaw, rp.next.yaw, a) };
    list.push({ pos, yaw: rp.cur.yaw, color: rp.color, headColor: HEAD_COLOR });
  }
  return list;
}

function updateNameplates(proj, view) {
  for (const rp of remotePlayers.values()) {
    if (!rp.el || !rp.cur) continue;
    const head = [rp.cur.pos[0], rp.cur.pos[1] + 2.0, rp.cur.pos[2]];
    const p = renderer.projectPoint(head, proj, view);
    if (p.visible) {
      rp.el.style.display = 'block';
      rp.el.style.left = p.x + 'px';
      rp.el.style.top = p.y + 'px';
    } else {
      rp.el.style.display = 'none';
    }
  }
}

// Snap the local clock toward the server's authoritative time (wrap-safe).
function snapTime(t) {
  let d = t - dayTime;
  if (d > 0.5) d -= 1;
  else if (d < -0.5) d += 1;
  dayTime = (dayTime + d + 1) % 1;
}

function randomRoomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

function setNetStatus(text) {
  if (!netStatusEl) return;
  netStatusEl.textContent = text;
  netStatusEl.classList.toggle('hidden', !text);
}

// Chat: capture keystrokes manually so opening it never drops pointer lock.
function setupChat() {
  document.addEventListener(
    'keydown',
    (e) => {
      if (!chatOpen) {
        if ((e.code === 'Enter' || e.code === 'KeyT') && input.locked) {
          chatOpen = true;
          chatDraft = '';
          renderChatInput();
          e.preventDefault();
        }
        return;
      }
      if (e.code === 'Enter') {
        const t = chatDraft.trim();
        if (t && net) net.sendChat(t);
        closeChat();
      } else if (e.code === 'Escape') {
        closeChat();
      } else if (e.code === 'Backspace') {
        chatDraft = chatDraft.slice(0, -1);
        renderChatInput();
      } else if (e.key.length === 1) {
        chatDraft += e.key;
        renderChatInput();
      }
      e.preventDefault();
      e.stopPropagation();
    },
    true // capture phase: run before input.js so typed keys never reach gameplay
  );
}

function renderChatInput() {
  if (!chatInputEl) return;
  chatInputEl.classList.remove('hidden');
  chatInputEl.textContent = '> ' + chatDraft;
}

function closeChat() {
  chatOpen = false;
  if (chatInputEl) chatInputEl.classList.add('hidden');
}

function addChat(name, text) {
  if (!chatLogEl) return;
  const line = document.createElement('div');
  line.textContent = name + ': ' + text;
  chatLogEl.appendChild(line);
  while (chatLogEl.childNodes.length > 8) chatLogEl.removeChild(chatLogEl.firstChild);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function updateDebug() {
  const clock = (dayTime * 24 + 6) % 24;
  const hh = String(Math.floor(clock)).padStart(2, '0');
  const mm = String(Math.floor((clock % 1) * 60)).padStart(2, '0');
  const seedLine = isMP
    ? `Seed: ${world.seed}  Room: ${roomCode}  Players: ${remotePlayers.size + 1}`
    : `Seed: ${world.seed}  (N = new world)`;
  debugEl.textContent =
    `Voxelcraft | ${Math.round(fps)} fps\n` +
    `XYZ: ${player.pos.map((v) => v.toFixed(1)).join(' / ')}\n` +
    `Chunk: ${Math.floor(player.pos[0] / CX)}, ${Math.floor(player.pos[2] / CZ)}  Loaded: ${world.chunks.size}\n` +
    `Time: ${hh}:${mm}  Mode: ${player.fly ? 'fly' : player.inWater ? 'swim' : 'walk'}\n` +
    `${seedLine}\n` +
    `Looking at: ${target ? BLOCKS[target.id].name : '-'}`;
}
