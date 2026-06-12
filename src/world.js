// Chunk storage and deterministic procedural terrain generation.

import { Perlin, mulberry32 } from './noise.js';
import { B } from './blocks.js';

export const CX = 16;
export const CZ = 16;
export const CY = 128;
export const SEA = 40;

const idx = (lx, y, lz) => lx + lz * CX + y * CX * CZ;

export class World {
  constructor(seed = 1337) {
    this.seed = seed | 0;
    this.chunks = new Map();
    this.noise = new Perlin(seed);
    this.cave = new Perlin(seed + 999);
  }

  key(cx, cz) {
    return cx + ',' + cz;
  }

  getChunk(cx, cz) {
    return this.chunks.get(this.key(cx, cz));
  }

  getBlock(x, y, z) {
    if (y < 0) return B.BEDROCK;
    if (y >= CY) return B.AIR;
    const cx = Math.floor(x / CX);
    const cz = Math.floor(z / CZ);
    const c = this.chunks.get(this.key(cx, cz));
    if (!c) return B.AIR;
    return c.blocks[idx(x - cx * CX, y, z - cz * CZ)];
  }

  // Returns the chunk coords whose meshes are affected by the edit.
  setBlock(x, y, z, id) {
    if (y < 0 || y >= CY) return [];
    const cx = Math.floor(x / CX);
    const cz = Math.floor(z / CZ);
    const c = this.getChunk(cx, cz);
    if (!c) return [];
    const lx = x - cx * CX;
    const lz = z - cz * CZ;
    c.blocks[idx(lx, y, lz)] = id;
    const affected = [[cx, cz]];
    // Border edits change neighbor face culling and AO.
    if (lx === 0) affected.push([cx - 1, cz]);
    if (lx === CX - 1) affected.push([cx + 1, cz]);
    if (lz === 0) affected.push([cx, cz - 1]);
    if (lz === CZ - 1) affected.push([cx, cz + 1]);
    if (lx === 0 && lz === 0) affected.push([cx - 1, cz - 1]);
    if (lx === 0 && lz === CZ - 1) affected.push([cx - 1, cz + 1]);
    if (lx === CX - 1 && lz === 0) affected.push([cx + 1, cz - 1]);
    if (lx === CX - 1 && lz === CZ - 1) affected.push([cx + 1, cz + 1]);
    for (const [ax, az] of affected) {
      const ac = this.getChunk(ax, az);
      if (ac) ac.dirty = true;
    }
    return affected;
  }

  heightAt(x, z) {
    const h = this.noise.fbm2(x * 0.0042, z * 0.0042, 5);
    let m = this.noise.fbm2(x * 0.0009 + 413.7, z * 0.0009 - 217.3, 3);
    m = Math.max(0, m + 0.1);
    const height = SEA + 3 + h * 14 + m * m * 55;
    return Math.max(6, Math.min(CY - 16, Math.round(height)));
  }

  surfaceY(x, z) {
    for (let y = CY - 1; y >= 0; y--) {
      const b = this.getBlock(x, y, z);
      if (b !== B.AIR && b !== B.WATER) return y;
    }
    return 0;
  }

  generateChunk(cx, cz) {
    const blocks = new Uint8Array(CX * CY * CZ);
    const rng = mulberry32(this.seed ^ Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663));
    const heights = new Int32Array(CX * CZ);

    for (let lz = 0; lz < CZ; lz++) {
      for (let lx = 0; lx < CX; lx++) {
        const wx = cx * CX + lx;
        const wz = cz * CZ + lz;
        const H = this.heightAt(wx, wz);
        heights[lx + lz * CX] = H;
        const sandy = H <= SEA + 2;
        const snowy = H >= SEA + 34;

        blocks[idx(lx, 0, lz)] = B.BEDROCK;
        for (let y = 1; y <= H; y++) {
          let b;
          if (y < H - 3) {
            b = B.STONE;
            if (y >= 6 && y < H - 6 && this.cave.noise3(wx * 0.075, y * 0.075, wz * 0.075) > 0.58) {
              b = B.AIR;
            } else {
              const r = rng();
              if (r < 0.0012 && y < 16) b = B.DIAMOND_ORE;
              else if (r < 0.0035 && y < 32) b = B.GOLD_ORE;
              else if (r < 0.011 && y < 56) b = B.IRON_ORE;
              else if (r < 0.023) b = B.COAL_ORE;
              else if (r < 0.033) b = B.GRAVEL;
            }
          } else if (y < H) {
            b = sandy ? B.SAND : B.DIRT;
          } else {
            b = sandy ? B.SAND : snowy ? B.SNOW : B.GRASS;
          }
          blocks[idx(lx, y, lz)] = b;
        }
        for (let y = H + 1; y <= SEA; y++) {
          blocks[idx(lx, y, lz)] = B.WATER;
        }
      }
    }

    // Trees: kept at local 2..13 so canopies never cross the chunk border.
    const treeCount = (rng() * 5) | 0;
    for (let i = 0; i < treeCount; i++) {
      const lx = 2 + ((rng() * 12) | 0);
      const lz = 2 + ((rng() * 12) | 0);
      const H = heights[lx + lz * CX];
      if (H <= SEA + 1 || blocks[idx(lx, H, lz)] !== B.GRASS) continue;
      const th = 4 + ((rng() * 3) | 0);
      if (H + th + 2 >= CY) continue;
      blocks[idx(lx, H, lz)] = B.DIRT;
      for (let y = H + 1; y <= H + th; y++) blocks[idx(lx, y, lz)] = B.LOG;
      for (let y = H + th - 2; y <= H + th + 1; y++) {
        const r = y >= H + th ? 1 : 2;
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (dx === 0 && dz === 0 && y <= H + th) continue;
            if (Math.abs(dx) === r && Math.abs(dz) === r && rng() < 0.5) continue;
            const j = idx(lx + dx, y, lz + dz);
            if (blocks[j] === B.AIR) blocks[j] = B.LEAVES;
          }
        }
      }
    }

    const chunk = { cx, cz, blocks, dirty: true, meshed: false };
    this.chunks.set(this.key(cx, cz), chunk);
    return chunk;
  }
}
