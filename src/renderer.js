// Raw WebGL2 renderer: one program for the world (opaque + water passes),
// a tiny line program for the targeted-block highlight, and a flat-shaded
// box program for remote players (multiplayer avatars).

import { mat4Identity, mat4Mul, mat4Translate, mat4RotX, mat4RotY } from './math.js';
import { MOB_TYPES } from './mobs.js';
import { ATLAS_COLS, ATLAS_ROWS } from './textures.js';

const WORLD_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in float aLight;
uniform mat4 uProj;
uniform mat4 uView;
out vec2 vUV;
out float vLight;
out float vDist;
void main() {
  vec4 vp = uView * vec4(aPos, 1.0);
  gl_Position = uProj * vp;
  vUV = aUV;
  vLight = aLight;
  vDist = length(vp.xyz);
}`;

const WORLD_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in float vLight;
in float vDist;
uniform sampler2D uTex;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uSun;
uniform float uWaterPass;
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, vUV);
  if (uWaterPass < 0.5 && c.a < 0.5) discard;
  vec3 lit = c.rgb * (vLight * uSun);
  float fog = clamp((vDist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
  outColor = vec4(mix(lit, uFogColor, fog), c.a);
}`;

const LINE_VS = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uProj;
uniform mat4 uView;
uniform vec3 uOffset;
void main() { gl_Position = uProj * uView * vec4(aPos + uOffset, 1.0); }`;

const LINE_FS = `#version 300 es
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(0.05, 0.05, 0.05, 1.0); }`;

// Flat-shaded boxes for remote players (no atlas/AO/fog — just a solid color
// per box with baked per-face shading so the cube reads as 3D).
const AVATAR_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in float aShade;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
out float vShade;
void main() {
  gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
  vShade = aShade;
}`;

const AVATAR_FS = `#version 300 es
precision highp float;
in float vShade;
uniform vec3 uColor;
out vec4 outColor;
void main() { outColor = vec4(uColor * vShade, 1.0); }`;

// Mob boxes: same flat-shaded box as avatars, but bodies are dimmed by daylight
// (uAmbient) so they read as dark/menacing at night, while emissive parts
// (lanterns, spore-sacs) stay bright. uAlpha lets hazard discs blend.
const MOB_FS = `#version 300 es
precision highp float;
in float vShade;
uniform vec3 uColor;
uniform float uEmissive;
uniform float uAmbient;
uniform float uAlpha;
out vec4 outColor;
void main() {
  float lit = mix(0.25 + 0.75 * uAmbient, 1.0, uEmissive);
  outColor = vec4(uColor * vShade * lit, uAlpha);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('Shader compile error: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function link(gl, vs, fs) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
  }
  return prog;
}

// Interleaved [x,y,z,shade] for a unit box: X,Z in [-0.5,0.5], Y in [0,1].
// Face shades match the world mesher (top 1.0, bottom 0.5, ±X 0.8, ±Z 0.65).
function buildBoxData() {
  const faces = [
    { s: 1.0, q: [[-0.5, 1, -0.5], [-0.5, 1, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5]] }, // top
    { s: 0.5, q: [[-0.5, 0, 0.5], [-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5]] }, // bottom
    { s: 0.8, q: [[0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5]] }, // +X
    { s: 0.8, q: [[-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0.5], [-0.5, 1, -0.5]] }, // -X
    { s: 0.65, q: [[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]] }, // +Z
    { s: 0.65, q: [[0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, -0.5], [0.5, 1, -0.5]] }, // -Z
  ];
  const data = [];
  for (const f of faces) {
    const [a, b, c, d] = f.q;
    for (const v of [a, b, c, a, c, d]) data.push(v[0], v[1], v[2], f.s);
  }
  return new Float32Array(data);
}

export class Renderer {
  constructor(canvas, atlasCanvas) {
    const gl = canvas.getContext('webgl2', { antialias: false });
    if (!gl) throw new Error('WebGL2 is not supported by this browser.');
    this.gl = gl;

    this.prog = link(gl, WORLD_VS, WORLD_FS);
    this.u = {
      proj: gl.getUniformLocation(this.prog, 'uProj'),
      view: gl.getUniformLocation(this.prog, 'uView'),
      tex: gl.getUniformLocation(this.prog, 'uTex'),
      fogColor: gl.getUniformLocation(this.prog, 'uFogColor'),
      fogNear: gl.getUniformLocation(this.prog, 'uFogNear'),
      fogFar: gl.getUniformLocation(this.prog, 'uFogFar'),
      sun: gl.getUniformLocation(this.prog, 'uSun'),
      waterPass: gl.getUniformLocation(this.prog, 'uWaterPass'),
    };

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.lineProg = link(gl, LINE_VS, LINE_FS);
    this.lu = {
      proj: gl.getUniformLocation(this.lineProg, 'uProj'),
      view: gl.getUniformLocation(this.lineProg, 'uView'),
      offset: gl.getUniformLocation(this.lineProg, 'uOffset'),
    };
    this.lineVao = gl.createVertexArray();
    gl.bindVertexArray(this.lineVao);
    const lo = -0.003, hi = 1.003;
    const c = [
      [lo, lo, lo], [hi, lo, lo], [hi, lo, hi], [lo, lo, hi],
      [lo, hi, lo], [hi, hi, lo], [hi, hi, hi], [lo, hi, hi],
    ];
    const edges = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
    const lineData = new Float32Array(edges.flatMap((i) => c[i]));
    const lineVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, lineVbo);
    gl.bufferData(gl.ARRAY_BUFFER, lineData, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);

    // Avatar program: a unit box ([-0.5,0.5] in X/Z, [0,1] in Y) with baked
    // per-face shading, reused with a per-player model matrix and color.
    this.avatarProg = link(gl, AVATAR_VS, AVATAR_FS);
    this.au = {
      proj: gl.getUniformLocation(this.avatarProg, 'uProj'),
      view: gl.getUniformLocation(this.avatarProg, 'uView'),
      model: gl.getUniformLocation(this.avatarProg, 'uModel'),
      color: gl.getUniformLocation(this.avatarProg, 'uColor'),
    };
    this.avatarVao = gl.createVertexArray();
    gl.bindVertexArray(this.avatarVao);
    const cubeVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cubeVbo);
    gl.bufferData(gl.ARRAY_BUFFER, buildBoxData(), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
    gl.bindVertexArray(null);

    // Mob program: reuses the avatar unit-box VAO, adds daylight/emissive/alpha.
    this.mobProg = link(gl, AVATAR_VS, MOB_FS);
    this.mu = {
      proj: gl.getUniformLocation(this.mobProg, 'uProj'),
      view: gl.getUniformLocation(this.mobProg, 'uView'),
      model: gl.getUniformLocation(this.mobProg, 'uModel'),
      color: gl.getUniformLocation(this.mobProg, 'uColor'),
      emissive: gl.getUniformLocation(this.mobProg, 'uEmissive'),
      ambient: gl.getUniformLocation(this.mobProg, 'uAmbient'),
      alpha: gl.getUniformLocation(this.mobProg, 'uAlpha'),
    };

    gl.enable(gl.DEPTH_TEST);
    this.meshes = new Map();
    this.heldCube = null; // lazily-built textured cube for the held block
  }

  makeBuffer(data) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 24, 20);
    gl.bindVertexArray(null);
    return { vao, vbo, count: data.length / 6 };
  }

  setChunkMesh(key, mesh) {
    this.removeChunk(key);
    const entry = {};
    if (mesh.opaque.length) entry.o = this.makeBuffer(mesh.opaque);
    if (mesh.water.length) entry.w = this.makeBuffer(mesh.water);
    this.meshes.set(key, entry);
  }

  removeChunk(key) {
    const entry = this.meshes.get(key);
    if (!entry) return;
    for (const b of [entry.o, entry.w]) {
      if (b) {
        this.gl.deleteVertexArray(b.vao);
        this.gl.deleteBuffer(b.vbo);
      }
    }
    this.meshes.delete(key);
  }

  // Free every chunk's GPU buffers (used when regenerating the world).
  clearMeshes() {
    for (const key of [...this.meshes.keys()]) this.removeChunk(key);
  }

  resize() {
    const c = this.gl.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.floor(c.clientWidth * dpr);
    const h = Math.floor(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      this.gl.viewport(0, 0, w, h);
    }
  }

  draw(s) {
    const gl = this.gl;
    this.resize();
    gl.clearColor(s.fogColor[0], s.fogColor[1], s.fogColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.proj, false, s.proj);
    gl.uniformMatrix4fv(this.u.view, false, s.view);
    gl.uniform3fv(this.u.fogColor, s.fogColor);
    gl.uniform1f(this.u.fogNear, s.fogNear);
    gl.uniform1f(this.u.fogFar, s.fogFar);
    gl.uniform1f(this.u.sun, s.sun);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.u.tex, 0);

    gl.uniform1f(this.u.waterPass, 0);
    for (const m of this.meshes.values()) {
      if (m.o) {
        gl.bindVertexArray(m.o.vao);
        gl.drawArrays(gl.TRIANGLES, 0, m.o.count);
      }
    }

    // Remote players: opaque boxes, drawn after terrain and before water so
    // they occlude correctly and water still blends over them. This switches
    // the active program, so re-bind the world program for the water pass.
    if (s.players && s.players.length) {
      this.drawPlayers(s.players, s.proj, s.view);
      gl.useProgram(this.prog); // world-program uniforms persist from above
    }

    // Mobs (opaque) + their spore projectiles, then translucent hazard discs.
    const ambient = s.ambient == null ? 1 : s.ambient;
    if ((s.mobs && s.mobs.length) || (s.projectiles && s.projectiles.length)) {
      this.drawMobs(s.mobs || [], s.projectiles || [], s.proj, s.view, ambient);
    }
    if (s.hazards && s.hazards.length) {
      this.drawHazards(s.hazards, s.proj, s.view, ambient);
    }
    if ((s.players && s.players.length) || (s.mobs && s.mobs.length) ||
        (s.projectiles && s.projectiles.length) || (s.hazards && s.hazards.length)) {
      gl.useProgram(this.prog); // re-bind world program for the water pass
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.uniform1f(this.u.waterPass, 1);
    for (const m of this.meshes.values()) {
      if (m.w) {
        gl.bindVertexArray(m.w.vao);
        gl.drawArrays(gl.TRIANGLES, 0, m.w.count);
      }
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    if (s.highlight) {
      gl.useProgram(this.lineProg);
      gl.uniformMatrix4fv(this.lu.proj, false, s.proj);
      gl.uniformMatrix4fv(this.lu.view, false, s.view);
      gl.uniform3f(this.lu.offset, s.highlight[0], s.highlight[1], s.highlight[2]);
      gl.bindVertexArray(this.lineVao);
      gl.drawArrays(gl.LINES, 0, 24);
    }

    if (s.viewmodel) this.drawViewmodel(s.proj, s.viewmodel);
    gl.bindVertexArray(null);
  }

  // Each player: { pos:[feetX,feetY,feetZ], yaw, color:[r,g,b] }. Drawn as a
  // body box + a head box scaled/placed to the 1.8-tall player AABB.
  drawPlayers(players, proj, view) {
    const gl = this.gl;
    gl.useProgram(this.avatarProg);
    gl.uniformMatrix4fv(this.au.proj, false, proj);
    gl.uniformMatrix4fv(this.au.view, false, view);
    gl.bindVertexArray(this.avatarVao);
    for (const p of players) {
      const base = mat4Mul(mat4Translate(p.pos[0], p.pos[1], p.pos[2]), mat4RotY(p.yaw));
      gl.uniform3fv(this.au.color, p.color);
      // Body: 0.6 wide, 1.2 tall, starting at the feet.
      this.drawBox(base, 0, 0.6, 1.2, 0.3);
      // Head: 0.5 cube on top of the body.
      gl.uniform3fv(this.au.color, p.headColor || p.color);
      this.drawBox(base, 1.2, 0.5, 0.5, 0.5);
    }
    gl.bindVertexArray(null);
  }

  drawBox(base, yOffset, w, h, d) {
    const gl = this.gl;
    // model = base · translate(0,yOffset,0) · scale(w,h,d)  (box Y spans [0,1]).
    const scale = new Float32Array([w, 0, 0, 0, 0, h, 0, 0, 0, 0, d, 0, 0, yOffset, 0, 1]);
    gl.uniformMatrix4fv(this.au.model, false, mat4Mul(base, scale));
    gl.drawArrays(gl.TRIANGLES, 0, 36);
  }

  // Mobs: each is { pos:[x,y,z], yaw, type, anim, scale, flags, projectiles? }.
  // Drawn as the type's list of colored boxes (mobs.js MOB_TYPES[].model.parts),
  // dimmed by `ambient` (daylight) with emissive parts kept bright. Opaque, so
  // drawn with the players between terrain and water.
  drawMobs(mobs, projectiles, proj, view, ambient) {
    const gl = this.gl;
    gl.useProgram(this.mobProg);
    gl.uniformMatrix4fv(this.mu.proj, false, proj);
    gl.uniformMatrix4fv(this.mu.view, false, view);
    gl.uniform1f(this.mu.ambient, ambient);
    gl.uniform1f(this.mu.alpha, 1);
    gl.bindVertexArray(this.avatarVao);

    for (const m of mobs) {
      const type = MOB_TYPES[m.type];
      const sc = m.scale || 1;
      const scaleM = new Float32Array([sc, 0, 0, 0, 0, sc, 0, 0, 0, 0, sc, 0, 0, 0, 0, 1]);
      const base = mat4Mul(
        mat4Mul(mat4Translate(m.pos[0], m.pos[1], m.pos[2]), mat4RotY(m.yaw || 0)),
        scaleM
      );
      const hurt = m.flags && m.flags.hurt > 0;
      const dim = m.flags && m.flags.observed;
      for (const part of type.model.parts) {
        let col = part.color;
        let emis = part.emissive ? 1 : 0;
        if (part.glow && dim) { col = [col[0] * 0.22, col[1] * 0.22, col[2] * 0.26]; emis = 0; }
        if (hurt) col = [Math.min(1, col[0] + 0.6), Math.min(1, col[1] + 0.5), Math.min(1, col[2] + 0.5)];
        gl.uniform3fv(this.mu.color, col);
        gl.uniform1f(this.mu.emissive, emis);
        gl.uniformMatrix4fv(this.mu.model, false, this.partMatrix(base, part, m.anim || 0));
        gl.drawArrays(gl.TRIANGLES, 0, 36);
      }
    }

    // Spore projectiles: small bright crimson cubes.
    if (projectiles && projectiles.length) {
      gl.uniform3fv(this.mu.color, [0.85, 0.15, 0.18]);
      gl.uniform1f(this.mu.emissive, 1);
      for (const p of projectiles) {
        const base = mat4Translate(p.pos[0], p.pos[1], p.pos[2]);
        const part = { off: [0, -0.16, 0], size: [0.32, 0.32, 0.32] };
        gl.uniformMatrix4fv(this.mu.model, false, this.partMatrix(base, part, 0));
        gl.drawArrays(gl.TRIANGLES, 0, 36);
      }
    }
    gl.bindVertexArray(null);
  }

  // Translucent ground discs for hazard zones (blended, no depth write).
  drawHazards(hazards, proj, view, ambient) {
    const gl = this.gl;
    gl.useProgram(this.mobProg);
    gl.uniformMatrix4fv(this.mu.proj, false, proj);
    gl.uniformMatrix4fv(this.mu.view, false, view);
    gl.uniform1f(this.mu.ambient, ambient);
    gl.uniform1f(this.mu.emissive, 1);
    gl.uniform3fv(this.mu.color, [0.7, 0.12, 0.12]);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.bindVertexArray(this.avatarVao);
    for (const h of hazards) {
      const fade = Math.max(0.18, Math.min(0.5, h.ttl / 5));
      gl.uniform1f(this.mu.alpha, fade);
      const part = { off: [0, 0, 0], size: [h.r * 2, 0.12, h.r * 2] };
      gl.uniformMatrix4fv(this.mu.model, false, this.partMatrix(mat4Translate(h.x, h.y, h.z), part, 0));
      gl.drawArrays(gl.TRIANGLES, 0, 36);
    }
    gl.uniform1f(this.mu.alpha, 1);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  // model = base · translate(off) · [anim rotation/scale] · scale(size).
  // Box-local space: X/Z in [-0.5,0.5], Y in [0,1] (same unit box as avatars).
  partMatrix(base, part, anim) {
    const [sx, sy, sz] = part.size;
    let s = new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1]);
    if (part.anim === 'pulse') {
      const k = 1 + 0.18 * Math.sin(anim);
      s = new Float32Array([sx * k, 0, 0, 0, 0, sy * k, 0, 0, 0, 0, sz * k, 0, 0, 0, 0, 1]);
    } else if (part.anim === 'flapL' || part.anim === 'flapR') {
      const a = (part.anim === 'flapL' ? 1 : -1) * (Math.sin(anim) * 0.6 + 0.15);
      const c = Math.cos(a), sn = Math.sin(a);
      const rotZ = new Float32Array([c, sn, 0, 0, -sn, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      s = mat4Mul(rotZ, s);
    }
    const t = mat4Translate(part.off[0], part.off[1], part.off[2]);
    return mat4Mul(base, mat4Mul(t, s));
  }

  // Project a world point to CSS-pixel screen coords using the live proj·view.
  // Returns { x, y, visible }; visible is false when behind the camera or
  // off-screen, so callers can hide nameplates instead of mis-placing them.
  projectPoint(point, proj, view) {
    const m = mat4Mul(proj, view); // column-major: m[col*4 + row]
    const x = point[0], y = point[1], z = point[2];
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 0) return { x: 0, y: 0, visible: false }; // at/behind camera
    const ndcX = cx / cw;
    const ndcY = cy / cw;
    const c = this.gl.canvas;
    return {
      x: (ndcX * 0.5 + 0.5) * c.clientWidth,
      y: (1 - (ndcY * 0.5 + 0.5)) * c.clientHeight,
      visible: ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1,
    };
  }

  // First-person held item: a hand plus the selected sword or block, drawn in
  // view space (camera at origin, -Z forward) on top of the world. vm = {
  //   kind:'tool'|'block', tiles:{top,side,bottom}, swing:0..1, bob:phase }.
  drawViewmodel(proj, vm) {
    const gl = this.gl;
    gl.clear(gl.DEPTH_BUFFER_BIT); // always render the hand over the world

    const arc = Math.sin(Math.max(0, Math.min(1, vm.swing || 0)) * Math.PI); // 0→1→0
    const bob = vm.bob || 0;
    const bx = Math.cos(bob) * 0.012;
    const by = Math.abs(Math.sin(bob)) * 0.014;
    // Place the grip at the lower-right of the view; swing dips it down/forward.
    let base = mat4Translate(0.5 + bx, -0.5 + by - arc * 0.18, -0.95);
    base = mat4Mul(base, mat4RotY(-0.42));
    base = mat4Mul(base, mat4RotX(0.18 + arc * 1.25));

    const SKIN = [0.86, 0.66, 0.5];
    // Hand + forearm (shared by both item types).
    gl.useProgram(this.avatarProg);
    gl.uniformMatrix4fv(this.au.proj, false, proj);
    gl.uniformMatrix4fv(this.au.view, false, mat4Identity());
    gl.bindVertexArray(this.avatarVao);
    this.vmBox(base, [0, -0.16, 0.02], [0.15, 0.22, 0.15], SKIN);   // fist
    this.vmBox(base, [0, -0.42, 0.05], [0.13, 0.3, 0.13], SKIN);    // forearm

    if (vm.kind === 'tool') {
      this.vmBox(base, [0, -0.13, 0], [0.06, 0.15, 0.06], [0.34, 0.21, 0.1]); // grip
      this.vmBox(base, [0, 0.0, 0], [0.26, 0.05, 0.1], [0.5, 0.37, 0.16]);    // guard
      this.vmBox(base, [0, 0.05, 0], [0.08, 0.62, 0.04], [0.78, 0.82, 0.88]); // blade
      this.vmBox(base, [-0.018, 0.05, 0], [0.025, 0.62, 0.042], [0.93, 0.96, 1.0]); // edge
      this.vmBox(base, [0, -0.18, 0], [0.1, 0.06, 0.1], [0.79, 0.64, 0.15]); // pommel
      gl.bindVertexArray(null);
    } else {
      gl.bindVertexArray(null);
      // Textured block cube via the world program (fog off, full sun).
      this.ensureHeldCube(vm.tiles);
      if (this.heldCube) {
        const blockMat = mat4Mul(base, mat4Mul(mat4Translate(0, 0.12, 0), scaleMat(0.4, 0.4, 0.4)));
        gl.useProgram(this.prog);
        gl.uniformMatrix4fv(this.u.proj, false, proj);
        gl.uniformMatrix4fv(this.u.view, false, blockMat); // world VS has no model → bake into view
        gl.uniform3f(this.u.fogColor, 0, 0, 0);
        gl.uniform1f(this.u.fogNear, 1000);
        gl.uniform1f(this.u.fogFar, 2000);
        gl.uniform1f(this.u.sun, 1.0);
        gl.uniform1f(this.u.waterPass, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.uniform1i(this.u.tex, 0);
        gl.bindVertexArray(this.heldCube.vao);
        gl.drawArrays(gl.TRIANGLES, 0, this.heldCube.count);
        gl.bindVertexArray(null);
      }
    }
  }

  // Draw one solid-color box for the viewmodel via the avatar program.
  vmBox(base, off, size, color) {
    const gl = this.gl;
    gl.uniform3fv(this.au.color, color);
    gl.uniformMatrix4fv(this.au.model, false, this.partMatrix(base, { off, size }, 0));
    gl.drawArrays(gl.TRIANGLES, 0, 36);
  }

  // (Re)build the held block's textured cube when the selected block changes.
  ensureHeldCube(tiles) {
    if (!tiles) return;
    const sig = tiles.top + ',' + tiles.side + ',' + tiles.bottom;
    if (this.heldCube && this.heldCube.sig === sig) return;
    if (this.heldCube) { this.gl.deleteVertexArray(this.heldCube.vao); this.gl.deleteBuffer(this.heldCube.vbo); }
    const buf = this.makeBuffer(buildHeldCubeData(tiles));
    buf.sig = sig;
    this.heldCube = buf;
  }
}

// A centered unit cube ([-0.5,0.5]^3) textured from the atlas, vertex layout
// [x,y,z,u,v,light] (matches the world mesher), with baked per-face shading.
function scaleMat(x, y, z) {
  return new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
}

function buildHeldCubeData(tiles) {
  const tw = 1 / ATLAS_COLS, th = 1 / ATLAS_ROWS;
  const faces = [
    { tile: tiles.side, shade: 0.8, c: [[0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [0.5, -0.5, -0.5]] }, // +X
    { tile: tiles.side, shade: 0.8, c: [[-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5], [-0.5, -0.5, 0.5]] }, // -X
    { tile: tiles.top, shade: 1.0, c: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] }, // +Y
    { tile: tiles.bottom, shade: 0.5, c: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] }, // -Y
    { tile: tiles.side, shade: 0.65, c: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] }, // +Z
    { tile: tiles.side, shade: 0.65, c: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]] }, // -Z
  ];
  const uvCorners = [[0, 1], [1, 1], [1, 0], [0, 0]];
  const order = [0, 1, 2, 0, 2, 3];
  const data = [];
  for (const f of faces) {
    const u0 = (f.tile % ATLAS_COLS) / ATLAS_COLS;
    const v0 = ((f.tile / ATLAS_COLS) | 0) / ATLAS_ROWS;
    for (const i of order) {
      const p = f.c[i];
      const [uu, vv] = uvCorners[i];
      data.push(p[0], p[1], p[2], u0 + (0.002 + uu * 0.996) * tw, v0 + (0.002 + vv * 0.996) * th, f.shade);
    }
  }
  return new Float32Array(data);
}
