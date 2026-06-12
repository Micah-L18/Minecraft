# Voxelcraft

A Minecraft-style voxel sandbox built **completely from scratch**: no game engine, no
libraries, no build tools, no image assets. Pure HTML + CSS + vanilla JavaScript rendering
through raw WebGL2. Even the 3D math, the Perlin noise, and every 16×16 pixel-art texture
are hand-written and generated procedurally at runtime.

The full specification that this implements lives in [PROMPT.md](PROMPT.md).

## Run it

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

(Any static file server works. ES modules require http://, not file://.)

## Controls

| Action | Input |
| --- | --- |
| Move | W A S D |
| Jump / swim up | Space |
| Sprint | Ctrl |
| Break block | Left mouse (hold) |
| Place block | Right mouse (hold) |
| Pick block | Middle mouse |
| Select hotbar slot | 1–9 or scroll wheel |
| Toggle fly (Space/Shift = up/down) | F |
| Toggle debug overlay | F3 |
| Release mouse | Esc |

## What's inside

- **Infinite terrain** streamed in 16×16×128 chunks: oceans, beaches, plains, hills,
  snow-capped mountains, caves, ores (coal/iron/gold/diamond), gravel pockets, trees,
  bedrock — all deterministic from a world seed.
- **Renderer**: per-chunk meshing with hidden-face culling, baked per-vertex ambient
  occlusion and directional shading, alpha-tested glass, blended semi-transparent water
  with a lowered surface, distance fog, and a day/night cycle (8-minute days).
- **Physics**: swept AABB collision, jumping, sprinting, swimming with buoyancy, fly mode.
- **Interaction**: voxel DDA raycast with block highlight, break/place/pick, 9-slot hotbar
  with procedurally drawn icons, F3 debug overlay.
- **Zero dependencies**: ~13 small source files, nothing else.

## Architecture

```
src/math.js      4x4 matrix helpers (column-major, WebGL convention)
src/noise.js     seeded PRNG + Perlin noise + fractal Brownian motion
src/blocks.js    block registry (solidity, opacity, atlas tiles)
src/textures.js  procedural pixel-art texture atlas
src/world.js     chunk storage + terrain generation
src/mesher.js    chunk -> interleaved vertex arrays (2 passes)
src/renderer.js  WebGL2 programs, chunk VAOs, draw passes
src/player.js    first-person physics
src/input.js     pointer lock, keyboard, mouse
src/raycast.js   voxel DDA for block targeting
src/main.js      game loop, chunk streaming, HUD
```

All art is original. Not affiliated with Mojang or Microsoft.
