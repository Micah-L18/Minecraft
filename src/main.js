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

const GEN_R = 6;     // generate terrain within this chunk radius
const MESH_R = 5;    // mesh/draw within this radius (needs generated neighbors for AO)
const UNLOAD_R = 9;  // free memory beyond this radius
const DAY_LEN = 480; // seconds per full day/night cycle
const REACH = 6;
const MOUSE_SENS = 0.0023;

const canvas = document.getElementById('glcanvas');
const overlay = document.getElementById('overlay');
const debugEl = document.getElementById('debug');

const atlas = buildAtlas();
const renderer = new Renderer(canvas, atlas);
const world = new World(20260611);
const input = new Input(canvas);
const player = new Player();

// Spawn: walk east from the origin to the first land column.
let spawnCX = 0;
for (let i = 0; i < 64; i++) {
  if (world.heightAt(i * CX + 8, 8) > SEA + 1) {
    spawnCX = i;
    break;
  }
}
for (let dx = -1; dx <= 1; dx++) {
  for (let dz = -1; dz <= 1; dz++) world.generateChunk(spawnCX + dx, dz);
}
player.pos = [spawnCX * CX + 8.5, world.surfaceY(spawnCX * CX + 8, 8) + 1.01, 8.5];

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

let last = performance.now();
requestAnimationFrame(function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05;

  const ev = input.consume();
  if (input.locked) {
    player.yaw -= ev.dx * MOUSE_SENS;
    player.pitch = Math.max(-1.55, Math.min(1.55, player.pitch - ev.dy * MOUSE_SENS));
  }
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
  if (ev.pressed.has('F3')) {
    debugVisible = !debugVisible;
    debugEl.classList.toggle('hidden', !debugVisible);
    if (!debugVisible) debugEl.textContent = '';
  }

  if (input.locked) player.update(dt, input, world);
  streamChunks();

  const eye = [player.pos[0], player.pos[1] + player.eyeH, player.pos[2]];
  const cp = Math.cos(player.pitch);
  const dir = [-Math.sin(player.yaw) * cp, Math.sin(player.pitch), -Math.cos(player.yaw) * cp];
  target = raycast(world, eye[0], eye[1], eye[2], dir[0], dir[1], dir[2], REACH);

  breakCd -= dt;
  placeCd -= dt;
  if (!input.buttons[0]) breakCd = 0;
  if (!input.buttons[2]) placeCd = 0;
  if (input.locked && target) {
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
  renderer.draw({
    proj: mat4Perspective((70 * Math.PI) / 180, aspect, 0.08, 480),
    view: viewMatrix(eye, player.yaw, player.pitch),
    sun,
    fogColor,
    fogNear,
    fogFar,
    highlight: target ? [target.x, target.y, target.z] : null,
  });

  debugTimer -= dt;
  if (debugVisible && debugTimer <= 0) {
    debugTimer = 0.25;
    updateDebug();
  }
});

function applyEdit(x, y, z, id) {
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
  for (let i = 0; i < Math.min(2, toGen.length); i++) world.generateChunk(toGen[i][1], toGen[i][2]);

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

function updateDebug() {
  const clock = (dayTime * 24 + 6) % 24;
  const hh = String(Math.floor(clock)).padStart(2, '0');
  const mm = String(Math.floor((clock % 1) * 60)).padStart(2, '0');
  debugEl.textContent =
    `Voxelcraft | ${Math.round(fps)} fps\n` +
    `XYZ: ${player.pos.map((v) => v.toFixed(1)).join(' / ')}\n` +
    `Chunk: ${Math.floor(player.pos[0] / CX)}, ${Math.floor(player.pos[2] / CZ)}  Loaded: ${world.chunks.size}\n` +
    `Time: ${hh}:${mm}  Mode: ${player.fly ? 'fly' : player.inWater ? 'swim' : 'walk'}\n` +
    `Looking at: ${target ? BLOCKS[target.id].name : '-'}`;
}
