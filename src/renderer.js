// Raw WebGL2 renderer: one program for the world (opaque + water passes),
// a tiny line program for the targeted-block highlight, and a flat-shaded
// box program for remote players (multiplayer avatars).

import { mat4Mul, mat4Translate, mat4RotY } from './math.js';

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

    gl.enable(gl.DEPTH_TEST);
    this.meshes = new Map();
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
}
