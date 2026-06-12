# The Build Prompt

This file is the master prompt that specifies this project. Feeding this prompt to a capable
AI coding agent (or a patient human) should reproduce an experience equivalent to the game in
this repository. Everything in `src/` is an implementation of this spec.

---

## PROMPT

You are building **a complete Minecraft-style voxel sandbox game from absolute zero**: no game
engine, no third-party libraries, no build tools, no image or sound assets. Pure HTML, CSS and
vanilla JavaScript (ES modules) rendering through raw WebGL2. All pixel art is generated
procedurally at runtime on a 2D canvas — design your own original 16×16 textures; do not copy
any existing game's assets. The game must run by serving the folder statically
(`python3 -m http.server`) and opening `index.html` in a modern browser.

### 1. Project structure

```
index.html      canvas, crosshair, hotbar, debug overlay, "click to play" overlay
style.css       HUD styling (pixelated icons, monospace debug text)
src/math.js     column-major mat4: identity, multiply, perspective, translate, rotX, rotY, viewMatrix
src/noise.js    mulberry32 seeded PRNG + classic 3D Perlin noise + 2D fractal Brownian motion
src/blocks.js   block registry: id, name, solid (collision), opaque (face culling), atlas tiles
src/textures.js procedural 16×16 pixel-art tiles packed into one atlas canvas (8 tiles per row)
src/world.js    chunk storage, terrain generation, block get/set
src/mesher.js   chunk → interleaved vertex arrays (face culling, ambient occlusion, 2 passes)
src/renderer.js WebGL2 program, atlas texture, per-chunk VAOs, opaque + water passes, highlight
src/player.js   first-person physics: gravity, jump, swim, fly, swept AABB collision
src/input.js    pointer lock, keyboard set, mouse deltas/buttons, scroll wheel
src/raycast.js  Amanatides–Woo voxel DDA raycast returning hit block + face normal
src/main.js     game loop, chunk streaming, block interaction, day/night, HUD
```

### 2. Blocks (18 ids)

air, grass, dirt, stone, sand, water, log, leaves, planks, cobblestone, glass, bedrock,
coal ore, iron ore, gold ore, diamond ore, gravel, snowy grass.

- `solid` drives collision (water and air are not solid).
- `opaque` drives face culling (water and glass are not opaque; leaves are opaque "fast" style).
- Each block maps to atlas tiles `{top, bottom, side}` — e.g. grass = green top, dirt bottom,
  dirt-with-grass-fringe side; log = ring tops, bark sides.
- Bedrock is unbreakable.

### 3. Pixel art (all procedural, deterministic per tile)

One 128×128 canvas atlas, 8×8 grid of 16×16 tiles, drawn with `createImageData` and a seeded
PRNG so every load looks identical. 20 tiles: grass top (speckled greens), grass side (dirt
with a ragged 2–4px grass fringe), dirt, stone (gray speckle), sand, water (blue speckle at
~65% alpha), log side (vertical bark streaks), log top (concentric rings), leaves (deep
mottled greens), planks (4px horizontal boards with dark seams and staggered joints),
cobblestone (Voronoi cells: nearest-of-8-points shading with dark borders), glass (transparent
center, pale frame, diagonal shine pixels), bedrock (harsh dark noise), 4 ores (stone base +
colored plus-shaped clusters: near-black coal, tan iron, yellow gold, cyan diamond), gravel
(random 4-color palette), snow top, snow side. Upload with NEAREST filtering, no mipmaps;
inset UVs ~0.2% per tile to avoid atlas bleeding.

### 4. World and terrain

- Chunks: 16×16 columns × 128 high, block ids in a flat `Uint8Array` (`x + z*16 + y*256`),
  stored in a `Map` keyed `"cx,cz"`. World is unbounded horizontally.
- Height map: `height = SEA(40) + 3 + fbm5(x·0.0042) · 14 + max(0, fbm3(x·0.0009)+0.1)² · 55`,
  clamped to [6, 112]. Gives oceans, beaches, plains, hills and snow-capped mountains (snow
  above y≈74).
- Strata: bedrock at y=0, stone up to height−4, then dirt, grass on top; sand instead of
  dirt/grass when the surface is at/below SEA+2; water fills any column gap up to SEA.
- Caves: carve stone to air where 3D Perlin at frequency 0.075 exceeds 0.58, only for
  6 ≤ y < height−6 so the surface stays intact.
- Ores while placing stone, rolled from a per-chunk seeded PRNG: diamond <0.0012 (y<16),
  gold <0.0035 (y<32), iron <0.011 (y<56), coal <0.023, gravel pockets <0.033.
- Trees: up to 4 per chunk on grass above sea level, trunks 4–6 logs placed at local
  coordinates 2..13 so canopies never cross the chunk border, leaf canopy radius 2 for the
  two layers below the top, radius 1 above, corners randomly chipped; dirt under the trunk.
- Generation is deterministic from a world seed.

### 5. Meshing (per chunk, rebuilt on edit)

- For every non-air block and each of its 6 faces: skip the face if the neighbor is opaque;
  skip water-against-water and glass-against-glass; water faces are also skipped against any
  opaque block. Everything else emits a quad (2 triangles).
- Vertex format: 6 floats — position xyz, atlas uv, light. Two arrays per chunk: opaque
  (includes alpha-tested glass/leaves) and water (alpha-blended).
- Lighting is baked per-vertex: face shade (top 1.0, bottom 0.5, ±X 0.8, ±Z 0.65) × ambient
  occlusion. AO samples the two edge neighbors and corner neighbor beyond each face vertex:
  `ao = (side1 && side2) ? 0 : 3 − (side1+side2+corner)`, mapped to brightness
  [0.45, 0.62, 0.82, 1.0].
- Surface water (no water above) renders 0.88 blocks tall so the waterline sits below eye
  level when standing at a shore.

### 6. Rendering (WebGL2)

- One program for the world. Vertex: `proj × view × pos`, passes uv, light, and view-space
  distance. Fragment: sample atlas, `discard` when alpha < 0.5 in the opaque pass (glass),
  multiply rgb by `light × sunIntensity`, then mix toward the fog color by
  `clamp((dist − fogNear) / (fogFar − fogNear), 0, 1)`.
- Pass 1: all opaque meshes, depth write on. Pass 2: water meshes with
  `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` blending and depth writes off.
- A second tiny line-list program draws a dark wireframe cube around the targeted block.
- Clear color = fog color = horizon sky color so terrain fades seamlessly into sky.
- 70° vertical FOV, near 0.08, far 480, device-pixel-ratio aware canvas resize.

### 7. Player physics

- AABB 0.6 wide × 1.8 tall, eye at 1.62. Per-axis movement resolution (Y then X then Z) in
  sub-steps of ≤0.45 blocks so fast falls never tunnel; on collision, snap flush to the block
  face and zero that velocity component; downward hits set `onGround`.
- Walk 4.3 m/s, sprint 5.6 (Ctrl), exponential acceleration (strong on ground, weak airborne).
  Gravity 30 m/s², jump velocity 8.6 (≈1.25 block jump), terminal velocity 50.
- Water: reduced gravity, sink capped at 3.5 m/s, Space swims up, horizontal speed ×0.55.
- Fly mode toggle (F): no gravity, 14 m/s, Space/Shift for up/down.

### 8. Interaction

- Voxel DDA raycast from the eye along the look vector, 6 block reach, returns block and
  entered face normal; water is see-through to the ray.
- Hold left mouse: break (0.25s repeat; bedrock immune). Hold right mouse: place the selected
  hotbar block into the face-adjacent cell if it is air/water and does not intersect the
  player AABB. Middle mouse: pick the targeted block into the hotbar.
- Edits mark the containing chunk (and border-adjacent chunks) dirty and remesh them
  immediately in the same frame.

### 9. Chunk streaming

Every frame, around the player's chunk: generate missing chunks within radius 6 (closest
first, ≤2 per frame), mesh chunks within radius 5 whose 8 neighbors are all generated
(closest first, ≤2 per frame, ensuring correct border faces and AO), unload chunks beyond
radius 9 (free GPU buffers). Spawn scans east from the origin for the first land column
(height > SEA+1), pre-generates 3×3 chunks there, and places the player on the surface.

### 10. Day/night cycle

A full day lasts 480 s. `daylight = clamp(sin(t·2π)·2.5 + 0.25, 0, 1)`;
`sunIntensity = 0.25 + 0.75·daylight` multiplies all block lighting. Sky/fog color lerps
between deep night blue and pale day blue, with an orange tint blended in near sunrise and
sunset. Underwater overrides fog to short-range deep blue.

### 11. HUD and controls

- Crosshair (CSS, blend-mode difference). 9-slot hotbar at bottom center with pixel-art icons
  drawn from the atlas (grass, dirt, stone, planks, log, leaves, glass, sand, cobblestone),
  selected via keys 1–9 or scroll wheel.
- F3 toggles a debug overlay: FPS, XYZ, current chunk, loaded chunk count, in-game clock,
  movement mode, targeted block name.
- A "click to play" overlay with the controls table requests pointer lock; Esc releases it
  and pauses input.

### 12. Acceptance checklist

1. Loads with zero console errors from a static file server in Chrome/Firefox.
2. Steady 60 fps with 121 chunks loaded on a typical laptop.
3. Walking in any direction forever keeps generating terrain; turning around shows the same
   terrain (deterministic seed).
4. You can dig to bedrock, find caves and ores, build a glass-and-plank house, climb a snowy
   mountain, swim across an ocean, and watch the sun set — all without a single asset file.

---

*Out of scope for v1 (good follow-ups): crafting/inventory, mobs, water flow simulation,
block lighting propagation (torches), saving to localStorage, sounds via WebAudio,
multiplayer.*
