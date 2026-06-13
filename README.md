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

## Multiplayer

Play together over a shared world. Start the game server (pure Node, **no install** — zero
dependencies):

```sh
node server/server.js          # listens on :25565 (PORT=25565 to change)
```

Serve the client as usual (`python3 -m http.server 8000`), then connect with `?server=`:

```
http://localhost:8000/?server=ws://localhost:25565&room=lobby&name=Steve
```

Share the same `server` + `room` URL with a friend (on your network, or any host that can
reach the server) and you join the same world. You can also fill the **Multiplayer** form on
the start screen instead of hand-writing the URL. The first person in a room fixes its random
seed; everyone in the room then shares the **same terrain, block edits, day/night time, and
chat**, and sees each other as labelled avatars. Press **Enter** or **T** to chat.

Because the world is generated from a shared seed, only the seed, block edits and player
positions travel over the network — never chunk data. *New world (N)* is single-player only.
Rooms live in the server's memory; restarting the server clears them.

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
| Generate a new random world (single-player) | N |
| Chat (multiplayer) | Enter / T |
| Toggle debug overlay | F3 |
| Release mouse | Esc |

## What's inside

- **Infinite terrain** streamed in 16×16×128 chunks: oceans, beaches, plains, hills,
  snow-capped mountains, caves, ores (coal/iron/gold/diamond), gravel pockets, trees,
  bedrock — all deterministic from a world seed.
- **Random map generation**: each load picks a random seed, **N** (or the overlay's
  *New Random World* button) regenerates a fresh map instantly, and the current seed is
  shown in the F3 overlay. Append `?seed=12345` to the URL (or type a seed on the start
  screen) to replay or share an exact world.
- **Renderer**: per-chunk meshing with hidden-face culling, baked per-vertex ambient
  occlusion and directional shading, alpha-tested glass, blended semi-transparent water
  with a lowered surface, distance fog, and a day/night cycle (8-minute days).
- **Physics**: swept AABB collision, jumping, sprinting, swimming with buoyancy, fly mode.
- **Interaction**: voxel DDA raycast with block highlight, break/place/pick, 9-slot hotbar
  with procedurally drawn icons, F3 debug overlay.
- **Multiplayer**: room-based co-op over a hand-rolled WebSocket server (pure Node, zero
  deps). Shared seed + edit log + day/night + chat; interpolated player avatars with
  nameplates. Only seed/edits/transforms cross the wire.
- **Zero dependencies**: a handful of small source files, nothing else.

## Architecture

```
src/math.js      4x4 matrix helpers (column-major, WebGL convention)
src/noise.js     seeded PRNG + Perlin noise + fractal Brownian motion
src/blocks.js    block registry (solidity, opacity, atlas tiles)
src/textures.js  procedural pixel-art texture atlas
src/world.js     chunk storage + terrain generation
src/mesher.js    chunk -> interleaved vertex arrays (2 passes)
src/renderer.js  WebGL2 programs, chunk VAOs, draw passes, player avatars
src/player.js    first-person physics
src/input.js     pointer lock, keyboard, mouse
src/raycast.js   voxel DDA for block targeting
src/net.js       client WebSocket wrapper (multiplayer)
src/main.js      game loop, chunk streaming, HUD, multiplayer sync
server/server.js hand-rolled WebSocket game server (rooms, edit log, relay)
```

All art is original. Not affiliated with Mojang or Microsoft.
