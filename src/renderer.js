// Raw WebGL2 renderer: one program for the world (opaque + water passes)
// and a tiny line program for the targeted-block highlight.

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
}
