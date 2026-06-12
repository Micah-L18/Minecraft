// Original procedural 16x16 pixel-art tiles, packed into one atlas canvas.
// Every tile is drawn from a seeded PRNG so the art is identical on every load.

import { mulberry32 } from './noise.js';
import { T } from './blocks.js';

export const TILE = 16;
export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 8;

const clampC = (v) => Math.max(0, Math.min(255, Math.round(v)));

function speckle(set, rng, base, vary, alpha = 255) {
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const d = (rng() - 0.5) * 2 * vary;
      set(x, y, clampC(base[0] + d), clampC(base[1] + d), clampC(base[2] + d), alpha);
    }
  }
}

function grassTop(set, rng) {
  speckle(set, rng, [104, 168, 62], 14);
  for (let i = 0; i < 14; i++) {
    set((rng() * TILE) | 0, (rng() * TILE) | 0, 88, 146, 50);
  }
}

function dirt(set, rng) {
  speckle(set, rng, [124, 88, 60], 14);
  for (let i = 0; i < 10; i++) {
    set((rng() * TILE) | 0, (rng() * TILE) | 0, 96, 66, 44);
  }
}

function grassSide(set, rng) {
  dirt(set, rng);
  for (let x = 0; x < TILE; x++) {
    const depth = 2 + ((rng() * 3) | 0);
    for (let y = 0; y < depth; y++) {
      const d = (rng() - 0.5) * 24;
      set(x, y, clampC(100 + d), clampC(164 + d), clampC(58 + d));
    }
  }
}

function stone(set, rng) {
  speckle(set, rng, [127, 127, 127], 9);
  for (let i = 0; i < 9; i++) {
    const x = 1 + ((rng() * 14) | 0), y = 1 + ((rng() * 14) | 0);
    set(x, y, 104, 104, 104);
    set(x + 1, y, 110, 110, 110);
  }
}

function sand(set, rng) {
  speckle(set, rng, [219, 207, 160], 11);
}

function water(set, rng) {
  speckle(set, rng, [47, 96, 198], 12, 168);
  for (let y = 2; y < TILE; y += 5) {
    for (let x = 0; x < TILE; x++) {
      if (rng() < 0.5) set(x, y, 78, 128, 222, 168);
    }
  }
}

function logSide(set, rng) {
  for (let x = 0; x < TILE; x++) {
    const dark = rng() < 0.25;
    const shade = (rng() - 0.5) * 18;
    for (let y = 0; y < TILE; y++) {
      const d = shade + (rng() - 0.5) * 10;
      if (dark) set(x, y, clampC(78 + d), clampC(60 + d), clampC(36 + d));
      else set(x, y, clampC(106 + d), clampC(84 + d), clampC(50 + d));
    }
  }
}

function logTop(set, rng) {
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const r = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      const ring = Math.round(r) % 2 === 0;
      const d = (rng() - 0.5) * 12;
      if (r >= 7) set(x, y, clampC(96 + d), clampC(76 + d), clampC(44 + d));
      else if (ring) set(x, y, clampC(176 + d), clampC(144 + d), clampC(92 + d));
      else set(x, y, clampC(150 + d), clampC(120 + d), clampC(72 + d));
    }
  }
}

function leaves(set, rng) {
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const d = (rng() - 0.5) * 36;
      if (rng() < 0.16) set(x, y, 30, 72, 22);
      else set(x, y, clampC(54 + d), clampC(118 + d), clampC(38 + d));
    }
  }
}

function planks(set, rng) {
  for (let y = 0; y < TILE; y++) {
    const board = (y / 4) | 0;
    const seamX = (board * 7 + 3) % TILE;
    for (let x = 0; x < TILE; x++) {
      const d = (rng() - 0.5) * 14;
      if (y % 4 === 3 || x === seamX) set(x, y, clampC(110 + d), clampC(86 + d), clampC(50 + d));
      else set(x, y, clampC(160 + d), clampC(130 + d), clampC(78 + d));
    }
  }
}

function cobble(set, rng) {
  // Voronoi cells: nearest of 8 jittered points decides the stone shade,
  // pixels near a second point become the dark mortar between stones.
  const pts = [];
  for (let i = 0; i < 8; i++) {
    pts.push([rng() * TILE, rng() * TILE, 100 + rng() * 70]);
  }
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      let d1 = 1e9, d2 = 1e9, shade = 128;
      for (const [px, py, ps] of pts) {
        // wrap distances so the tile is seamless
        const dx = Math.min(Math.abs(x - px), TILE - Math.abs(x - px));
        const dy = Math.min(Math.abs(y - py), TILE - Math.abs(y - py));
        const d = dx * dx + dy * dy;
        if (d < d1) { d2 = d1; d1 = d; shade = ps; }
        else if (d < d2) d2 = d;
      }
      const g = clampC(Math.sqrt(d2) - Math.sqrt(d1) < 1.1 ? 62 : shade + (rng() - 0.5) * 14);
      set(x, y, g, g, g);
    }
  }
}

function glass(set, rng) {
  for (let x = 0; x < TILE; x++) {
    for (const y of [0, TILE - 1]) {
      set(x, y, 205, 228, 240);
      set(y, x, 205, 228, 240);
    }
  }
  for (let i = 0; i < 6; i++) {
    const x = 2 + ((rng() * 8) | 0);
    set(x + i > 13 ? 13 : x, 2 + i, 235, 248, 255);
  }
}

function bedrock(set, rng) {
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const g = rng() < 0.4 ? 38 + rng() * 20 : 78 + rng() * 30;
      set(x, y, clampC(g), clampC(g), clampC(g));
    }
  }
}

function ore(color) {
  return (set, rng) => {
    stone(set, rng);
    for (let i = 0; i < 5; i++) {
      const x = 2 + ((rng() * 12) | 0), y = 2 + ((rng() * 12) | 0);
      const d = (rng() - 0.5) * 20;
      set(x, y, clampC(color[0] + d), clampC(color[1] + d), clampC(color[2] + d));
      set(x + 1, y, clampC(color[0] - 12), clampC(color[1] - 12), clampC(color[2] - 12));
      set(x, y + 1, clampC(color[0] - 12), clampC(color[1] - 12), clampC(color[2] - 12));
    }
  };
}

function gravel(set, rng) {
  const palette = [[130, 126, 122], [100, 96, 92], [152, 146, 138], [88, 82, 76]];
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const c = palette[(rng() * palette.length) | 0];
      set(x, y, c[0], c[1], c[2]);
    }
  }
}

function snowTop(set, rng) {
  speckle(set, rng, [238, 244, 250], 7);
}

function snowSide(set, rng) {
  dirt(set, rng);
  for (let x = 0; x < TILE; x++) {
    const depth = 3 + ((rng() * 3) | 0);
    for (let y = 0; y < depth; y++) {
      const d = (rng() - 0.5) * 12;
      set(x, y, clampC(238 + d), clampC(244 + d), clampC(250 + d));
    }
  }
}

const PAINTERS = {
  [T.GRASS_TOP]: grassTop,
  [T.GRASS_SIDE]: grassSide,
  [T.DIRT]: dirt,
  [T.STONE]: stone,
  [T.SAND]: sand,
  [T.WATER]: water,
  [T.LOG_SIDE]: logSide,
  [T.LOG_TOP]: logTop,
  [T.LEAVES]: leaves,
  [T.PLANKS]: planks,
  [T.COBBLE]: cobble,
  [T.GLASS]: glass,
  [T.BEDROCK]: bedrock,
  [T.COAL]: ore([42, 42, 42]),
  [T.IRON]: ore([214, 164, 120]),
  [T.GOLD]: ore([250, 216, 76]),
  [T.DIAMOND]: ore([96, 219, 213]),
  [T.GRAVEL]: gravel,
  [T.SNOW_TOP]: snowTop,
  [T.SNOW_SIDE]: snowSide,
};

export function buildAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLS * TILE;
  canvas.height = ATLAS_ROWS * TILE;
  const ctx = canvas.getContext('2d');
  for (const [tileIndex, painter] of Object.entries(PAINTERS)) {
    const t = Number(tileIndex);
    const img = ctx.createImageData(TILE, TILE);
    const set = (x, y, r, g, b, a = 255) => {
      const i = (y * TILE + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = a;
    };
    painter(set, mulberry32(1000 + t * 7919));
    ctx.putImageData(img, (t % ATLAS_COLS) * TILE, ((t / ATLAS_COLS) | 0) * TILE);
  }
  return canvas;
}
