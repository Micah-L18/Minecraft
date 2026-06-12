// Chunk meshing: visible-face extraction with baked shading + ambient occlusion.
// Vertex layout: x, y, z, u, v, light  (6 floats, interleaved).

import { BLOCKS, B } from './blocks.js';
import { CX, CY, CZ } from './world.js';
import { ATLAS_COLS, ATLAS_ROWS } from './textures.js';

const FACES = [
  { dir: [1, 0, 0], axis: 0, shade: 0.8, corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { dir: [-1, 0, 0], axis: 0, shade: 0.8, corners: [[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]] },
  { dir: [0, 1, 0], axis: 1, shade: 1.0, corners: [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]] },
  { dir: [0, -1, 0], axis: 1, shade: 0.5, corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { dir: [0, 0, 1], axis: 2, shade: 0.65, corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { dir: [0, 0, -1], axis: 2, shade: 0.65, corners: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]] },
];

const AO_BRIGHTNESS = [0.45, 0.62, 0.82, 1.0];
const QUAD = [0, 1, 2, 0, 2, 3];

function occludes(world, x, y, z) {
  return BLOCKS[world.getBlock(x, y, z)].opaque ? 1 : 0;
}

function vertexAO(world, x, y, z, face, corner) {
  const a = face.axis;
  const a1 = (a + 1) % 3;
  const a2 = (a + 2) % 3;
  const base = [x + face.dir[0], y + face.dir[1], z + face.dir[2]];
  const o1 = corner[a1] ? 1 : -1;
  const o2 = corner[a2] ? 1 : -1;
  const p1 = base.slice();
  p1[a1] += o1;
  const p2 = base.slice();
  p2[a2] += o2;
  const pc = base.slice();
  pc[a1] += o1;
  pc[a2] += o2;
  const s1 = occludes(world, p1[0], p1[1], p1[2]);
  const s2 = occludes(world, p2[0], p2[1], p2[2]);
  if (s1 && s2) return 0;
  return 3 - (s1 + s2 + occludes(world, pc[0], pc[1], pc[2]));
}

function emitFace(arr, world, x, y, z, face, tile, isWater, lowerTop) {
  const ts = 1 / ATLAS_COLS;
  const u0 = (tile % ATLAS_COLS) / ATLAS_COLS;
  const v0 = ((tile / ATLAS_COLS) | 0) / ATLAS_ROWS;
  const verts = [];
  for (const c of face.corners) {
    const px = x + c[0];
    const py = y + (c[1] === 1 && lowerTop ? 0.88 : c[1]);
    const pz = z + c[2];
    let u, v;
    if (face.axis === 0) { u = c[2]; v = 1 - c[1]; }
    else if (face.axis === 2) { u = c[0]; v = 1 - c[1]; }
    else { u = c[0]; v = c[2]; }
    let light = face.shade;
    if (!isWater) light *= AO_BRIGHTNESS[vertexAO(world, x, y, z, face, c)];
    // Inset UVs slightly so NEAREST sampling never bleeds into adjacent tiles.
    verts.push([px, py, pz, u0 + (0.002 + u * 0.996) * ts, v0 + (0.002 + v * 0.996) * ts, light]);
  }
  for (const i of QUAD) arr.push(...verts[i]);
}

export function buildChunkMesh(world, cx, cz) {
  const opaque = [];
  const water = [];
  const x0 = cx * CX;
  const z0 = cz * CZ;
  for (let y = 0; y < CY; y++) {
    for (let lz = 0; lz < CZ; lz++) {
      for (let lx = 0; lx < CX; lx++) {
        const x = x0 + lx;
        const z = z0 + lz;
        const id = world.getBlock(x, y, z);
        if (id === B.AIR) continue;
        const def = BLOCKS[id];
        const isWater = id === B.WATER;
        const lowerTop = isWater && world.getBlock(x, y + 1, z) !== B.WATER;
        for (const face of FACES) {
          const nid = world.getBlock(x + face.dir[0], y + face.dir[1], z + face.dir[2]);
          if (BLOCKS[nid].opaque) continue;
          if (nid === id) continue;
          const tile =
            face.dir[1] === 1 ? def.tiles.top : face.dir[1] === -1 ? def.tiles.bottom : def.tiles.side;
          emitFace(isWater ? water : opaque, world, x, y, z, face, tile, isWater, lowerTop);
        }
      }
    }
  }
  return { opaque: new Float32Array(opaque), water: new Float32Array(water) };
}
