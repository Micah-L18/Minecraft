// Enemy mobs: type table, model descriptions and a single deterministic
// simulation step shared by BOTH the browser (single-player, authoritative) and
// the Node server (multiplayer, authoritative). This module is DOM-free and has
// no imports — it only does scalar math and calls methods on a World instance
// passed in via ctx, so it loads unchanged under Node and the browser.
//
// Coordinate convention matches players: pos = [x, y, z] are FEET coords, x/z
// the centre of the footprint and y the bottom. Footing uses world.heightAt()
// (pure noise — no generated chunks needed), so the server can simulate ground
// collision for surface mobs without mirroring chunk generation. Line-of-sight
// is a heightfield approximation for the same reason. (v1 limitation: caves and
// player edits are ignored for footing/LOS.)

export const MOB = { GLOAMSTALKER: 0, MIREBELCHER: 1, GLOAMWING: 2 };

// Per-type stats + render model. `model.parts` are colored boxes in mob-local
// space (X/Z centred at the part's off, Y rising from off[1]); the renderer and
// the AABB both read this table so server and client agree on size/look.
export const MOB_TYPES = [
  {
    name: 'Gloamstalker',
    w: 0.6, h: 2.3, d: 0.6,
    maxHp: 24, speed: 7.8, accel: 14, grav: 26,
    contactDmg: 4, contactKnock: 7, contactReach: 1.1, contactCd: 0.8,
    animRate: 6,
    aerial: false,
    spawn: { maxLight: 0.32, weight: 1, cap: 3 }, // night/dark only
    model: {
      parts: [
        { off: [-0.16, 0, 0], size: [0.18, 1.05, 0.2], color: [0.06, 0.06, 0.09] }, // leg L
        { off: [0.16, 0, 0], size: [0.18, 1.05, 0.2], color: [0.06, 0.06, 0.09] },  // leg R
        { off: [0, 1.0, 0], size: [0.48, 0.95, 0.34], color: [0.09, 0.09, 0.13] },  // torso
        { off: [-0.33, 1.0, 0], size: [0.12, 1.0, 0.12], color: [0.07, 0.07, 0.1] },// arm L
        { off: [0.33, 1.0, 0], size: [0.12, 1.0, 0.12], color: [0.07, 0.07, 0.1] }, // arm R
        { off: [0, 1.92, 0], size: [0.42, 0.42, 0.42], color: [1.0, 0.72, 0.26], emissive: 1, glow: 1 }, // lantern head
      ],
      eyeFrac: 0.85,
    },
  },
  {
    name: 'Mirebelcher',
    w: 1.6, h: 1.2, d: 1.6,
    maxHp: 30, speed: 2.4, accel: 8, grav: 26,
    contactDmg: 3, contactKnock: 4, contactReach: 1.3, contactCd: 1.0,
    range: 12, keepDist: 7, projSpeed: 13, projCd: 2.6, projGrav: 18,
    burrowTrigger: 4.5, burrowTime: 1.3, burrowDist: 9, burrowCd: 4,
    hazardR: 2.2, hazardTtl: 5, hazardDps: 4,
    animRate: 4,
    aerial: false,
    spawn: { maxLight: 1, weight: 1, cap: 3 }, // any time
    model: {
      parts: [
        { off: [0, 0.22, 0], size: [1.4, 0.8, 1.4], color: [0.22, 0.34, 0.18] },   // body
        { off: [-0.55, 0, -0.55], size: [0.22, 0.28, 0.22], color: [0.12, 0.18, 0.1] }, // legs
        { off: [0.55, 0, -0.55], size: [0.22, 0.28, 0.22], color: [0.12, 0.18, 0.1] },
        { off: [-0.55, 0, 0.55], size: [0.22, 0.28, 0.22], color: [0.12, 0.18, 0.1] },
        { off: [0.55, 0, 0.55], size: [0.22, 0.28, 0.22], color: [0.12, 0.18, 0.1] },
        { off: [0, 0.3, -0.72], size: [0.7, 0.42, 0.22], color: [0.08, 0.07, 0.05] }, // maw
        { off: [0, 0.95, 0.15], size: [0.34, 0.34, 0.34], color: [0.86, 0.13, 0.16], emissive: 1, glow: 1, anim: 'pulse' },
        { off: [-0.38, 0.88, 0.42], size: [0.26, 0.26, 0.26], color: [0.82, 0.1, 0.14], emissive: 1, glow: 1, anim: 'pulse' },
        { off: [0.38, 0.88, 0.42], size: [0.26, 0.26, 0.26], color: [0.82, 0.1, 0.14], emissive: 1, glow: 1, anim: 'pulse' },
      ],
      eyeFrac: 0.6,
    },
  },
  {
    name: 'Gloamwing',
    w: 0.7, h: 0.7, d: 0.7,
    maxHp: 8, speed: 9.5, accel: 9, grav: 0,
    contactDmg: 0, contactReach: 1.4, contactCd: 1,
    flyHeight: 6, latchRange: 1.6, latchDps: 3, latchCd: 2.5,
    animRate: 18,
    aerial: true,
    splitInto: 2, splitGen: 1,
    spawn: { maxLight: 0.5, weight: 1, cap: 4 }, // dusk/night
    model: {
      parts: [
        { off: [0, 0.18, 0], size: [0.38, 0.32, 0.6], color: [0.62, 0.76, 0.96] }, // body
        { off: [0, 0.26, -0.34], size: [0.26, 0.26, 0.26], color: [0.72, 0.84, 0.99] }, // head
        { off: [-0.18, 0.28, 0], size: [0.95, 0.05, 0.55], color: [0.55, 0.7, 0.95], anim: 'flapL' }, // wing L
        { off: [0.18, 0.28, 0], size: [0.95, 0.05, 0.55], color: [0.55, 0.7, 0.95], anim: 'flapR' },   // wing R
        { off: [0, 0.05, 0.36], size: [0.1, 0.5, 0.1], color: [0.5, 0.64, 0.9] }, // tendril
      ],
      eyeFrac: 0.45,
    },
  },
];

// --- small vector helpers ---------------------------------------------------

function len2(x, z) { return Math.hypot(x, z); }
function len3(x, y, z) { return Math.hypot(x, y, z); }

export function dirFromYawPitch(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}

// Daylight in [0,1] from dayTime in [0,1] — MUST match main.js / server.js.
export function daylightAt(t) {
  const s = Math.sin(t * Math.PI * 2);
  return Math.max(0, Math.min(1, s * 2.5 + 0.25));
}

// Top surface Y at a column: feet rest here. heightAt is pure noise.
function groundY(world, x, z) {
  return world.heightAt(Math.floor(x), Math.floor(z)) + 1;
}

// Heightfield line-of-sight: true if the terrain surface never rises above the
// straight segment a->b. An approximation (ignores caves/edits) used identically
// on client and server so the "is it observed" verdict matches in both modes.
function losClear(world, a, b) {
  const d = len3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const steps = Math.max(2, Math.ceil(d));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    const z = a[2] + (b[2] - a[2]) * t;
    if (y < world.heightAt(Math.floor(x), Math.floor(z)) + 0.5) return false;
  }
  return true;
}

function mobCenter(mob) {
  const t = MOB_TYPES[mob.type];
  return [mob.pos[0], mob.pos[1] + t.h * t.model.eyeFrac, mob.pos[2]];
}

// Nearest living observer to a mob (by horizontal distance).
function nearestObserver(mob, observers) {
  let best = null, bestD = Infinity;
  for (const o of observers) {
    if (!o.alive) continue;
    const d = len2(o.pos[0] - mob.pos[0], o.pos[2] - mob.pos[2]);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best ? { o: best, dist: bestD } : null;
}

// Is any observer aiming at the mob (within a cone) with clear line of sight?
// This is the Gloamstalker's "being watched" test; the ANY-observer rule falls
// out for free because every room player is in the observers list.
function isObserved(world, mob, observers) {
  const c = mobCenter(mob);
  for (const o of observers) {
    if (!o.alive) continue;
    const tx = c[0] - o.eye[0], ty = c[1] - o.eye[1], tz = c[2] - o.eye[2];
    const dist = len3(tx, ty, tz);
    if (dist > 42) continue;          // too far to "see" (beyond fog-ish range)
    if (dist < 0.6) return true;       // point blank
    const dot = (tx * o.dir[0] + ty * o.dir[1] + tz * o.dir[2]) / dist;
    if (dot > 0.86 && losClear(world, o.eye, c)) return true; // ~30° cone + LOS
  }
  return false;
}

// --- spawning ---------------------------------------------------------------

export function spawnMob(type, pos, gen, nextId) {
  const t = MOB_TYPES[type];
  const scale = gen > 0 ? 0.66 : 1;
  return {
    id: nextId(),
    type,
    pos: [pos[0], pos[1], pos[2]],
    vel: [0, 0, 0],
    yaw: 0,
    hp: Math.max(2, Math.round(t.maxHp * (gen > 0 ? 0.34 : 1))),
    maxHp: Math.max(2, Math.round(t.maxHp * (gen > 0 ? 0.34 : 1))),
    gen,
    scale,
    state: 'idle',
    stateT: 0,
    attackCd: 0,
    abilityCd: gen > 0 ? 0 : 1.5,
    latchedTo: -1,
    invuln: 0.6, // brief spawn grace
    anim: 0,
    flags: { observed: false, hurt: 0 },
  };
}

// Trickle new mobs in around observers, gated by day/night. Rate is scaled by
// dt so the per-second spawn rate is identical whether called at 60 Hz (SP
// frame) or ~15 Hz (server tick). Returns the mobs created this call.
export function maybeSpawn(mobs, ctx, policy) {
  const spawned = [];
  if (mobs.length >= policy.cap) return spawned;
  if (ctx.rng() > policy.rate * ctx.dt) return spawned;
  const daylight = daylightAt(ctx.dayTime);

  // Current population by type, so the always-eligible daytime mob can't fill
  // the whole global cap and starve the night-only types (per-type caps).
  const counts = new Array(MOB_TYPES.length).fill(0);
  for (const m of mobs) counts[m.type]++;

  // Eligible = light gating allows it now AND it is under its own per-type cap.
  const allowed = [];
  let totalW = 0;
  for (let i = 0; i < MOB_TYPES.length; i++) {
    const sp = MOB_TYPES[i].spawn;
    if (daylight <= sp.maxLight && counts[i] < (sp.cap ?? policy.cap)) {
      allowed.push(i);
      totalW += sp.weight;
    }
  }
  if (!allowed.length) return spawned;

  // Weighted random pick among the eligible types (honours spawn.weight).
  let rw = ctx.rng() * totalW;
  let type = allowed[allowed.length - 1];
  for (const i of allowed) {
    rw -= MOB_TYPES[i].spawn.weight;
    if (rw <= 0) {
      type = i;
      break;
    }
  }

  // Place on a ring around a random living observer.
  const live = ctx.observers.filter((o) => o.alive);
  if (!live.length) return spawned;
  const o = live[(ctx.rng() * live.length) | 0];
  const ang = ctx.rng() * Math.PI * 2;
  const r = policy.minR + ctx.rng() * (policy.maxR - policy.minR);
  const x = o.pos[0] + Math.cos(ang) * r;
  const z = o.pos[2] + Math.sin(ang) * r;

  // Keep clear of every observer's personal space.
  for (const ob of live) {
    if (len2(ob.pos[0] - x, ob.pos[2] - z) < policy.minR * 0.6) return spawned;
  }

  const t = MOB_TYPES[type];
  const gy = groundY(ctx.world, x, z);
  const y = t.aerial ? gy + t.flyHeight : gy;
  spawned.push(spawnMob(type, [x, y, z], 0, ctx.nextId));
  mobs.push(spawned[spawned.length - 1]);
  return spawned;
}

// Remove mobs that have wandered far from every observer (latched mobs stay).
// Returns the ids removed so callers can drop client-side render state.
export function despawnFar(mobs, observers, maxDist) {
  const removed = [];
  for (let i = mobs.length - 1; i >= 0; i--) {
    const m = mobs[i];
    if (m.latchedTo !== -1) continue;
    let near = false;
    for (const o of observers) {
      if (len2(o.pos[0] - m.pos[0], o.pos[2] - m.pos[2]) < maxDist) { near = true; break; }
    }
    if (!near) { removed.push(m.id); mobs.splice(i, 1); }
  }
  return removed;
}

// --- combat (called by the sword-attack path on client SP / server MP) ------

// Ray-vs-AABB (slab) + a close-range cone fallback, so melee always connects on
// a mob you're facing. Returns the nearest hittable mob or null. Skips latched
// Gloamwings (must be shaken off) and burrowed/invulnerable mobs.
export function pickAttackTarget(mobs, eye, dir, tool) {
  let best = null, bestT = Infinity;
  for (const m of mobs) {
    if (m.latchedTo !== -1 || m.invuln > 0 || m.state === 'burrow') continue;
    const t = MOB_TYPES[m.type];
    const half = [t.w / 2, t.h / 2, t.d / 2];
    const c = [m.pos[0], m.pos[1] + t.h / 2, m.pos[2]];
    const hit = segmentAABB(eye, dir, tool.range, c, half, 0.25);
    if (hit !== null && hit < bestT) { bestT = hit; best = m; continue; }
    // Cone fallback for point-blank swings.
    const tx = c[0] - eye[0], ty = c[1] - eye[1], tz = c[2] - eye[2];
    const dist = len3(tx, ty, tz);
    if (dist < tool.range && dist > 1e-3) {
      const dot = (tx * dir[0] + ty * dir[1] + tz * dir[2]) / dist;
      if (dot > tool.cone && dist < bestT) { bestT = dist; best = m; }
    }
  }
  return best;
}

// Distance along ray (origin o, unit dir d, max len) to an AABB (centre c,
// half-extents h expanded by margin), or null if no hit within len.
function segmentAABB(o, d, maxLen, c, h, margin) {
  let tmin = 0, tmax = maxLen;
  for (let a = 0; a < 3; a++) {
    const lo = c[a] - h[a] - margin, hi = c[a] + h[a] + margin;
    if (Math.abs(d[a]) < 1e-8) {
      if (o[a] < lo || o[a] > hi) return null;
    } else {
      let t1 = (lo - o[a]) / d[a], t2 = (hi - o[a]) / d[a];
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

// Apply sword damage to a mob: knockback + flash, and on death the Gloamwing
// split. Returns { died, spawned } so the caller updates its mob list. The
// caller is responsible for removing a died mob and appending spawned ones.
export function hurtMob(mob, dmg, knock, ctx) {
  if (mob.invuln > 0 || mob.latchedTo !== -1) return { died: false, spawned: [] };
  mob.hp -= dmg;
  mob.vel[0] += knock[0];
  mob.vel[1] += Math.max(knock[1], 2.5);
  mob.vel[2] += knock[2];
  mob.flags.hurt = 0.18;
  if (mob.hp > 0) return { died: false, spawned: [] };
  const t = MOB_TYPES[mob.type];
  const spawned = [];
  if (t.splitInto && mob.gen < t.splitGen) {
    for (let i = 0; i < t.splitInto; i++) {
      const ox = (i === 0 ? -1 : 1) * 0.6;
      const child = spawnMob(mob.type, [mob.pos[0] + ox, mob.pos[1] + 0.4, mob.pos[2]], mob.gen + 1, ctx.nextId);
      child.vel = [ox * 4, 3, (ctx.rng() - 0.5) * 4];
      spawned.push(child);
    }
  }
  return { died: true, spawned };
}

// --- the shared per-tick simulation -----------------------------------------

// Advances every mob, projectile and hazard one step. Mutates the arrays in
// place. Returns { events, hazardsChanged }:
//   events: [{ kind:'damage', playerId, amount, knock:[x,y,z] }
//          | { kind:'latch', playerId, mobId }
//          | { kind:'unlatch', playerId, mobId }]
// The caller applies events to its player(s): SP passes one observer (the local
// player, id 0); the server passes every room player and routes by playerId.
export function stepMobs(mobs, hazards, projectiles, ctx) {
  const events = [];
  let hazardsChanged = false;
  const dt = ctx.dt;

  for (const m of mobs) {
    const t = MOB_TYPES[m.type];
    if (m.invuln > 0) m.invuln -= dt;
    if (m.attackCd > 0) m.attackCd -= dt;
    if (m.abilityCd > 0) m.abilityCd -= dt;
    if (m.flags.hurt > 0) m.flags.hurt -= dt;
    m.anim += dt * t.animRate;

    if (t.aerial) stepFlyer(m, t, ctx, events, projectiles);
    else if (m.type === MOB.MIREBELCHER) stepBelcher(m, t, ctx, events, projectiles);
    else stepStalker(m, t, ctx, events);
  }

  // Projectiles: ballistic arcs that bloom a hazard where they land.
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.vel[1] -= p.grav * dt;
    p.pos[0] += p.vel[0] * dt;
    p.pos[1] += p.vel[1] * dt;
    p.pos[2] += p.vel[2] * dt;
    p.ttl -= dt;
    const gy = groundY(ctx.world, p.pos[0], p.pos[2]);
    if (p.pos[1] <= gy || p.ttl <= 0) {
      hazards.push({
        id: ctx.nextId(), x: p.pos[0], y: gy, z: p.pos[2],
        r: p.hazardR, ttl: p.hazardTtl, tickCd: 0, dps: p.hazardDps,
      });
      hazardsChanged = true;
      projectiles.splice(i, 1);
    }
  }

  // Hazard zones: tick damage to observers standing inside, then expire.
  for (let i = hazards.length - 1; i >= 0; i--) {
    const h = hazards[i];
    h.ttl -= dt;
    h.tickCd -= dt;
    if (h.tickCd <= 0) {
      h.tickCd = 0.5;
      for (const o of ctx.observers) {
        if (!o.alive) continue;
        if (len2(o.pos[0] - h.x, o.pos[2] - h.z) < h.r && Math.abs(o.pos[1] - h.y) < 3) {
          events.push({ kind: 'damage', playerId: o.id, amount: h.dps * 0.5, knock: [0, 0, 0] });
        }
      }
    }
    if (h.ttl <= 0) { hazards.splice(i, 1); hazardsChanged = true; }
  }

  return { events, hazardsChanged };
}

// Apply gravity + integrate Y and snap to the surface. Returns true if grounded.
function fall(m, t, ctx) {
  m.vel[1] -= t.grav * ctx.dt;
  if (m.vel[1] < -55) m.vel[1] = -55;
  m.pos[1] += m.vel[1] * ctx.dt;
  const gy = groundY(ctx.world, m.pos[0], m.pos[2]);
  if (m.pos[1] <= gy) { m.pos[1] = gy; m.vel[1] = 0; return true; }
  return false;
}

// Steer horizontally toward (or away from) a target point at a given speed.
function steerXZ(m, t, ctx, tx, tz, speed, sign) {
  const dx = tx - m.pos[0], dz = tz - m.pos[2];
  const d = len2(dx, dz) || 1;
  const wantX = (dx / d) * speed * sign;
  const wantZ = (dz / d) * speed * sign;
  const k = Math.min(1, t.accel * ctx.dt);
  m.vel[0] += (wantX - m.vel[0]) * k;
  m.vel[2] += (wantZ - m.vel[2]) * k;
  m.pos[0] += m.vel[0] * ctx.dt;
  m.pos[2] += m.vel[2] * ctx.dt;
  m.yaw = Math.atan2(-dx * sign, -dz * sign);
}

function tryContact(m, t, ctx, near, events) {
  if (!t.contactDmg || m.attackCd > 0) return;
  const o = near.o;
  if (near.dist < t.contactReach + t.w / 2 && Math.abs(o.pos[1] - m.pos[1]) < t.h) {
    const dx = o.pos[0] - m.pos[0], dz = o.pos[2] - m.pos[2];
    const d = len2(dx, dz) || 1;
    events.push({
      kind: 'damage', playerId: o.id, amount: t.contactDmg,
      knock: [(dx / d) * t.contactKnock, 3, (dz / d) * t.contactKnock],
    });
    m.attackCd = t.contactCd;
  }
}

// Gloamstalker: frozen while watched, rushes + strikes when unobserved.
function stepStalker(m, t, ctx, events) {
  const grounded = fall(m, t, ctx);
  const near = nearestObserver(m, ctx.observers);
  const observed = isObserved(ctx.world, m, ctx.observers);
  m.flags.observed = observed;
  if (!near) { m.state = 'idle'; return; }
  if (observed) {
    m.state = 'frozen';
    m.vel[0] = 0; m.vel[2] = 0;
    return;
  }
  m.state = 'rush';
  if (grounded || true) steerXZ(m, t, ctx, near.o.pos[0], near.o.pos[2], t.speed, 1);
  tryContact(m, t, ctx, near, events);
}

// Mirebelcher: kite at range, lob arcing spore bombs, burrow away if rushed.
function stepBelcher(m, t, ctx, events, projectiles) {
  fall(m, t, ctx);
  const near = nearestObserver(m, ctx.observers);
  if (!near) { m.state = 'idle'; return; }

  if (m.state === 'burrow') {
    m.stateT -= ctx.dt;
    m.invuln = Math.max(m.invuln, 0.1);
    if (m.stateT <= 0) {
      // Resurface on the far side of the player to re-establish range.
      const dx = m.pos[0] - near.o.pos[0], dz = m.pos[2] - near.o.pos[2];
      const d = len2(dx, dz) || 1;
      const nx = near.o.pos[0] + (dx / d) * t.burrowDist;
      const nz = near.o.pos[2] + (dz / d) * t.burrowDist;
      m.pos[0] = nx; m.pos[2] = nz;
      m.pos[1] = groundY(ctx.world, nx, nz);
      m.vel = [0, 0, 0];
      m.state = 'idle';
      m.abilityCd = 0.6;
    }
    return;
  }

  if (near.dist < t.burrowTrigger && m.abilityCd <= 0) {
    m.state = 'burrow';
    m.stateT = t.burrowTime;
    m.abilityCd = t.burrowCd;
    return;
  }

  // Kite: hold the sweet spot around keepDist.
  if (near.dist > t.range) steerXZ(m, t, ctx, near.o.pos[0], near.o.pos[2], t.speed, 1);
  else if (near.dist < t.keepDist) steerXZ(m, t, ctx, near.o.pos[0], near.o.pos[2], t.speed, -1);
  else { m.vel[0] *= 0.6; m.vel[2] *= 0.6; m.yaw = Math.atan2(near.o.pos[0] - m.pos[0], near.o.pos[2] - m.pos[2]); }

  // Lob a spore bomb when in range with line of sight.
  if (near.dist < t.range && m.abilityCd <= 0) {
    const src = [m.pos[0], m.pos[1] + 0.8, m.pos[2]];
    const tgt = near.o;
    if (losClear(ctx.world, src, [tgt.pos[0], tgt.pos[1] + 1, tgt.pos[2]])) {
      const dx = tgt.pos[0] - src[0], dz = tgt.pos[2] - src[2];
      const d = len2(dx, dz) || 1;
      const flight = d / t.projSpeed;
      // vy so the arc lands near the target's feet under projGrav.
      const dy = tgt.pos[1] - src[1];
      const vy = dy / flight + 0.5 * t.projGrav * flight;
      projectiles.push({
        id: ctx.nextId(),
        pos: src.slice(),
        vel: [(dx / d) * t.projSpeed, vy, (dz / d) * t.projSpeed],
        grav: t.projGrav, ttl: flight + 1.5,
        hazardR: t.hazardR, hazardTtl: t.hazardTtl, hazardDps: t.hazardDps,
      });
      m.abilityCd = t.projCd;
      m.state = 'lob';
    }
  }
  tryContact(m, t, ctx, near, events);
}

// Gloamwing: erratic flight, swoop + latch onto the camera, DoT until shaken.
function stepFlyer(m, t, ctx, events, projectiles) {
  const near = nearestObserver(m, ctx.observers);

  if (m.latchedTo !== -1) {
    const o = ctx.observers.find((ob) => ob.id === m.latchedTo);
    if (!o || !o.alive) { m.latchedTo = -1; m.state = 'flee'; return; }
    // Ride the player's eye so it renders right in their face.
    m.pos = [o.eye[0], o.eye[1] - 0.2, o.eye[2]];
    m.vel = [0, 0, 0];
    m.state = 'latched';
    m.attackCd -= ctx.dt; // reuse as DoT timer
    if (m.attackCd <= 0) {
      m.attackCd = 0.5;
      events.push({ kind: 'damage', playerId: o.id, amount: t.latchDps * 0.5, knock: [0, 0, 0] });
    }
    return;
  }

  if (!near) {
    // Idle hover.
    const gy = groundY(ctx.world, m.pos[0], m.pos[2]);
    m.pos[1] += (gy + t.flyHeight - m.pos[1]) * Math.min(1, 2 * ctx.dt);
    m.state = 'idle';
    return;
  }

  // Aim for the player's head with a weaving, bobbing offset.
  const o = near.o;
  const weave = Math.sin(m.anim * 0.5) * 1.5;
  const perpX = Math.cos(Math.atan2(o.pos[0] - m.pos[0], o.pos[2] - m.pos[2]));
  const tx = o.pos[0] + perpX * weave;
  const tz = o.pos[2] - Math.sin(Math.atan2(o.pos[0] - m.pos[0], o.pos[2] - m.pos[2])) * weave;
  const ty = o.eye[1] + Math.sin(m.anim * 0.7) * 0.8;

  const dx = tx - m.pos[0], dy = ty - m.pos[1], dz = tz - m.pos[2];
  const d = len3(dx, dy, dz) || 1;
  const k = Math.min(1, t.accel * ctx.dt);
  m.vel[0] += ((dx / d) * t.speed - m.vel[0]) * k;
  m.vel[1] += ((dy / d) * t.speed - m.vel[1]) * k;
  m.vel[2] += ((dz / d) * t.speed - m.vel[2]) * k;
  m.pos[0] += m.vel[0] * ctx.dt;
  m.pos[1] += m.vel[1] * ctx.dt;
  m.pos[2] += m.vel[2] * ctx.dt;
  const floor = groundY(ctx.world, m.pos[0], m.pos[2]) + 1;
  if (m.pos[1] < floor) m.pos[1] = floor;
  m.yaw = Math.atan2(-dx, -dz);
  m.state = 'swoop';

  // Latch when it reaches the player's head.
  const headDist = len3(o.eye[0] - m.pos[0], o.eye[1] - m.pos[1], o.eye[2] - m.pos[2]);
  if (headDist < t.latchRange && m.abilityCd <= 0) {
    m.latchedTo = o.id;
    m.attackCd = 0.5;
    events.push({ kind: 'latch', playerId: o.id, mobId: m.id });
  }
}
