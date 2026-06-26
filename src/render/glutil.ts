/**
 * Small dependency-free WebGL2 helpers shared by all GL scenes.
 *
 * Conventions:
 * - GLSL ES 3.00 (`#version 300 es` must be the first line of every source).
 * - Premultiplied-alpha output: fragment shaders emit colour already multiplied
 *   by alpha, so the renderer's premultipliedAlpha context composites cleanly
 *   over a transparent page (OBS overlay mode).
 */

/**
 * Fullscreen-triangle vertex shader. Emits a single oversized triangle covering
 * the viewport from gl_VertexID alone — no vertex buffers needed. Passes a 0..1
 * `vUv` to the fragment stage (origin bottom-left).
 */
export const FULLSCREEN_VERT = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  // 0,1,2 -> a triangle that covers the [-1,1] clip square.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('Failed to create shader object');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? '(no info log)';
    gl.deleteShader(sh);
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    throw new Error(`GLSL ${kind} shader compile failed:\n${log}`);
  }
  return sh;
}

/**
 * Compile + link a program from vertex/fragment sources. Throws with the full
 * GLSL info log on any failure (fail loud in dev). The shader objects are
 * flagged for deletion once linked; the returned program owns them.
 */
export function compileProgram(
  gl: WebGL2RenderingContext,
  vertSrc: string,
  fragSrc: string,
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram();
  if (!prog) throw new Error('Failed to create program object');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  // Detach + delete: the program keeps the linked binary.
  gl.detachShader(prog, vs);
  gl.detachShader(prog, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) ?? '(no info log)';
    gl.deleteProgram(prog);
    throw new Error(`GLSL program link failed:\n${log}`);
  }
  return prog;
}

/**
 * An empty VAO usable for attribute-less fullscreen draws. WebGL2 requires a
 * bound VAO for `drawArrays`; this provides one without any vertex buffers.
 */
export function createEmptyVao(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error('Failed to create VAO');
  return vao;
}

/**
 * Draw a single fullscreen triangle. Binds the given empty VAO (or a transient
 * one), issues a 3-vertex draw, and leaves the VAO bound. The active program is
 * assumed to use {@link FULLSCREEN_VERT}.
 */
export function drawFullscreen(
  gl: WebGL2RenderingContext,
  vao: WebGLVertexArrayObject,
): void {
  gl.bindVertexArray(vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/** A colour render target: a texture + the framebuffer that draws into it. */
export interface Fbo {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

/**
 * Create a colour FBO of size w×h. `internalFormat` defaults to RGBA8; pass a
 * float format (e.g. gl.RGBA16F) for HDR/feedback targets — the caller must
 * have verified float-colour support via {@link checkFloatColorSupport}.
 */
export function createFbo(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  internalFormat: number = gl.RGBA8,
): Fbo {
  const tex = gl.createTexture();
  if (!tex) throw new Error('Failed to create FBO texture');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('Failed to create framebuffer');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`Framebuffer incomplete: 0x${status.toString(16)}`);
  }
  return { fbo, tex, w, h };
}

/** Free an FBO's GPU resources. */
export function disposeFbo(gl: WebGL2RenderingContext, f: Fbo): void {
  gl.deleteFramebuffer(f.fbo);
  gl.deleteTexture(f.tex);
}

/** A ping-pong pair of identically-sized FBOs for feedback/sim passes. */
export interface PingPong {
  read: Fbo;
  write: Fbo;
  /** Swap read/write after a pass. */
  swap(): void;
  dispose(gl: WebGL2RenderingContext): void;
}

/** Create a ping-pong FBO pair (used by feedback / fluid scenes). */
export function createPingPong(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  internalFormat: number = gl.RGBA8,
): PingPong {
  let a = createFbo(gl, w, h, internalFormat);
  let b = createFbo(gl, w, h, internalFormat);
  return {
    get read() {
      return a;
    },
    get write() {
      return b;
    },
    swap() {
      const tmp = a;
      a = b;
      b = tmp;
    },
    dispose(g: WebGL2RenderingContext) {
      disposeFbo(g, a);
      disposeFbo(g, b);
    },
  };
}

/** Result of probing the context for float-colour render support. */
export interface FloatColorSupport {
  /** Can render to RGBA16F/RG16F colour attachments (EXT_color_buffer_float). */
  rgba16f: boolean;
  /** Can render to RGBA32F (EXT_color_buffer_float covers this on WebGL2). */
  rgba32f: boolean;
  /** True if linear filtering of float textures is available. */
  floatLinear: boolean;
}

/**
 * Probe float-colour render support once at context creation. The procedural
 * scenes here don't need it, but the future fluid scene will require RG16F /
 * RGBA16F render targets, so we expose the capability up front.
 */
export function checkFloatColorSupport(gl: WebGL2RenderingContext): FloatColorSupport {
  const colorBufferFloat = gl.getExtension('EXT_color_buffer_float') !== null;
  const floatLinear = gl.getExtension('OES_texture_float_linear') !== null;
  return {
    rgba16f: colorBufferFloat,
    rgba32f: colorBufferFloat,
    floatLinear,
  };
}

/**
 * Cache of uniform locations for a program, looked up lazily by name. Avoids
 * per-frame string→location lookups while keeping call sites terse.
 */
export class Uniforms {
  private readonly cache = new Map<string, WebGLUniformLocation | null>();
  private readonly gl: WebGL2RenderingContext;
  private readonly prog: WebGLProgram;

  constructor(gl: WebGL2RenderingContext, prog: WebGLProgram) {
    this.gl = gl;
    this.prog = prog;
  }

  private loc(name: string): WebGLUniformLocation | null {
    let l = this.cache.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.prog, name);
      this.cache.set(name, l);
    }
    return l;
  }

  f1(name: string, x: number): void {
    this.gl.uniform1f(this.loc(name), x);
  }
  i1(name: string, x: number): void {
    this.gl.uniform1i(this.loc(name), x);
  }
  f2(name: string, x: number, y: number): void {
    this.gl.uniform2f(this.loc(name), x, y);
  }
  f3(name: string, x: number, y: number, z: number): void {
    this.gl.uniform3f(this.loc(name), x, y, z);
  }
  /** Set a vec3 from a 3-tuple (no allocation when reused). */
  v3(name: string, v: readonly [number, number, number]): void {
    this.gl.uniform3f(this.loc(name), v[0], v[1], v[2]);
  }
  f4(name: string, x: number, y: number, z: number, w: number): void {
    this.gl.uniform4f(this.loc(name), x, y, z, w);
  }
  /** Upload a vec4 array from a flat Float32Array (length = count*4). */
  v4array(name: string, data: Float32Array): void {
    this.gl.uniform4fv(this.loc(name), data);
  }
}
