// First-person player: walking, sprinting, jumping, swimming, flying,
// with per-axis swept AABB collision against the voxel world.

import { BLOCKS, B } from './blocks.js';

const HALF_W = 0.3;
const HEIGHT = 1.8;
const MAX_STEP = 0.45; // sub-step length so fast falls never tunnel through blocks

export class Player {
  constructor() {
    this.pos = [0, 80, 0];
    this.vel = [0, 0, 0];
    this.yaw = 0;
    this.pitch = 0;
    this.eyeH = 1.62;
    this.onGround = false;
    this.inWater = false;
    this.fly = false;
  }

  update(dt, input, world) {
    const keys = input.keys;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let fx = 0, fz = 0;
    if (keys.has('KeyW')) { fx -= sin; fz -= cos; }
    if (keys.has('KeyS')) { fx += sin; fz += cos; }
    if (keys.has('KeyA')) { fx -= cos; fz += sin; }
    if (keys.has('KeyD')) { fx += cos; fz -= sin; }
    const len = Math.hypot(fx, fz);
    if (len > 0) { fx /= len; fz /= len; }

    this.inWater =
      world.getBlock(Math.floor(this.pos[0]), Math.floor(this.pos[1] + 0.4), Math.floor(this.pos[2])) ===
      B.WATER;

    const sprint = keys.has('ControlLeft') || keys.has('ControlRight');
    let speed = this.fly ? 14 : sprint ? 5.6 : 4.3;
    if (this.inWater && !this.fly) speed *= 0.55;
    const accel = this.fly ? 10 : this.onGround ? 12 : 4;
    const k = Math.min(1, accel * dt);
    this.vel[0] += (fx * speed - this.vel[0]) * k;
    this.vel[2] += (fz * speed - this.vel[2]) * k;

    if (this.fly) {
      let vy = 0;
      if (keys.has('Space')) vy += 9;
      if (keys.has('ShiftLeft') || keys.has('ShiftRight')) vy -= 9;
      this.vel[1] += (vy - this.vel[1]) * Math.min(1, 10 * dt);
    } else if (this.inWater) {
      this.vel[1] -= 12 * dt;
      if (this.vel[1] < -3.5) this.vel[1] = -3.5;
      if (keys.has('Space')) this.vel[1] = Math.min(this.vel[1] + 40 * dt, 4);
    } else {
      this.vel[1] -= 30 * dt;
      if (this.vel[1] < -50) this.vel[1] = -50;
      if (this.onGround && keys.has('Space')) this.vel[1] = 8.6;
    }

    this.onGround = false;
    this.moveAxis(world, 1, this.vel[1] * dt);
    this.moveAxis(world, 0, this.vel[0] * dt);
    this.moveAxis(world, 2, this.vel[2] * dt);
  }

  collides(world, x, y, z) {
    const x0 = Math.floor(x - HALF_W), x1 = Math.floor(x + HALF_W);
    const y0 = Math.floor(y), y1 = Math.floor(y + HEIGHT);
    const z0 = Math.floor(z - HALF_W), z1 = Math.floor(z + HALF_W);
    for (let i = x0; i <= x1; i++) {
      for (let j = y0; j <= y1; j++) {
        for (let k = z0; k <= z1; k++) {
          if (BLOCKS[world.getBlock(i, j, k)].solid) return true;
        }
      }
    }
    return false;
  }

  moveAxis(world, axis, d) {
    while (d !== 0) {
      const step = Math.max(-MAX_STEP, Math.min(MAX_STEP, d));
      d -= step;
      if (!this.stepAxis(world, axis, step)) break;
    }
  }

  // Returns false when a collision stopped the movement on this axis.
  stepAxis(world, axis, d) {
    const p = this.pos.slice();
    p[axis] += d;
    if (!this.collides(world, p[0], p[1], p[2])) {
      this.pos = p;
      return true;
    }
    const eps = 1e-3;
    if (axis === 1) {
      if (d < 0) {
        this.pos[1] = Math.floor(p[1]) + 1 + eps;
        this.onGround = true;
      } else {
        this.pos[1] = Math.floor(p[1] + HEIGHT) - HEIGHT - eps;
      }
    } else if (d > 0) {
      this.pos[axis] = Math.floor(p[axis] + HALF_W) - HALF_W - eps;
    } else {
      this.pos[axis] = Math.floor(p[axis] - HALF_W) + 1 + HALF_W + eps;
    }
    this.vel[axis] = 0;
    return false;
  }
}
