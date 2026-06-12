// Voxel DDA raycast (Amanatides & Woo). Returns the first targetable block
// along the ray with the normal of the face the ray entered through.

import { B } from './blocks.js';

export function raycast(world, ox, oy, oz, dx, dy, dz, maxDist) {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tMaxX = dx !== 0 ? (stepX > 0 ? x + 1 - ox : ox - x) * tDeltaX : Infinity;
  let tMaxY = dy !== 0 ? (stepY > 0 ? y + 1 - oy : oy - y) * tDeltaY : Infinity;
  let tMaxZ = dz !== 0 ? (stepZ > 0 ? z + 1 - oz : oz - z) * tDeltaZ : Infinity;
  let nx = 0, ny = 0, nz = 0;

  for (let i = 0; i < 256; i++) {
    const id = world.getBlock(x, y, z);
    if (id !== B.AIR && id !== B.WATER) {
      return { x, y, z, nx, ny, nz, id };
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      if (tMaxX > maxDist) break;
      x += stepX;
      tMaxX += tDeltaX;
      nx = -stepX; ny = 0; nz = 0;
    } else if (tMaxY < tMaxZ) {
      if (tMaxY > maxDist) break;
      y += stepY;
      tMaxY += tDeltaY;
      nx = 0; ny = -stepY; nz = 0;
    } else {
      if (tMaxZ > maxDist) break;
      z += stepZ;
      tMaxZ += tDeltaZ;
      nx = 0; ny = 0; nz = -stepZ;
    }
  }
  return null;
}
