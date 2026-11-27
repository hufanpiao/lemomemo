// 官网首页脚本：粒子（手写 WebGL），只用在开场——大字散成声波，再聚成第 1 组标题。
// 每颗点三个去处：0 开场大字、1 第 1 组标题、2 声波
const VS = `
attribute vec4 aT0; attribute vec4 aR;
uniform vec2 uRes; uniform float uT, uA, uB, uK, uAmp, uAlpha, uSize, uDpr, uBar;
uniform vec2 uWave;
varying float vA;
float ez(float t){ return t < .5 ? 4. * t * t * t : 1. - pow(-2. * t + 2., 3.) * .5; }
float env(float x, float t){
float u = x / uRes.x;
float w = smoothstep(0., .12, u) * smoothstep(1., .88, u);
float a = .5 + .5 * sin(x * .019 + t * 2.3);
float b = .5 + .5 * sin(x * .0071 - t * 1.4 + 1.3);
float c = .5 + .5 * sin(x * .053 + t * 4.1);
return w * (.08 + .92 * pow(a * b, .7) * (.45 + .55 * c));
}
vec2 tgt(float i){
if (i < .5) return aT0.xy;
if (i < 1.5) return aT0.zw;
float col = (floor(aR.y * uRes.x / uBar) + .5) * uBar;
return vec2(col, uWave.x + (aR.z * 2. - 1.) * env(col, uT) * uWave.y);
}
void main(){
float st = clamp((uK - aR.x * .35) / .65, 0., 1.);
float e = ez(st);
vec2 p = mix(tgt(uA), tgt(uB), e);
vec2 dir = vec2(cos(aR.w * 6.2832), sin(aR.w * 6.2832)) * (.35 + .65 * aR.z);
p += dir * uAmp * sin(3.14159 * e);
vA = uAlpha;
vec2 c = p / uRes * 2. - 1.;
gl_Position = vec4(c.x, -c.y, 0., 1.);
gl_PointSize = uSize * uDpr * (.85 + .4 * fract(aR.z * 17.3));
}`;
const FS = `precision mediump float; varying float vA;
void main(){ vec2 d = gl_PointCoord - .5; float a = smoothstep(.5, .28, length(d)) * vA; gl_FragColor = vec4(vec3(.078, .082, .094) * a, a); }`;

function sampleText(el, n, W, VH, ref) {
  const cv = document.createElement('canvas'); cv.width = Math.ceil(W); cv.height = Math.ceil(VH);
  const x = cv.getContext('2d', { willReadFrequently: true });
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), rg = document.createRange();
  let nd, x0 = W, y0 = VH, x1 = 0, y1 = 0;
  x.textAlign = 'center'; x.fillStyle = '#000';
  while ((nd = tw.nextNode())) {
    const str = nd.data;
    const pcs = getComputedStyle(nd.parentElement);
    x.font = `${pcs.fontWeight} ${pcs.fontSize} ${pcs.fontFamily}`;
    const m = x.measureText('明'), asc = m.fontBoundingBoxAscent, des = m.fontBoundingBoxDescent;
    x.textBaseline = asc ? 'alphabetic' : 'middle';
    const chars = Array.from(str);
    let idx = 0;
    for (const ch of chars) {
      const len = ch.length;
      if (!/\s/.test(ch)) {
        rg.setStart(nd, idx); rg.setEnd(nd, idx + len);
        const r = rg.getBoundingClientRect();
        if (r.width) {
          const cx = r.left - ref.left + r.width / 2;
          const cy = asc ? r.top - ref.top + asc * r.height / (asc + des) : r.top - ref.top + r.height / 2;
          x.fillText(ch, cx, cy);
          x0 = Math.min(x0, r.left - ref.left - 4); y0 = Math.min(y0, r.top - ref.top - 4); x1 = Math.max(x1, r.right - ref.left + 4); y1 = Math.max(y1, r.bottom - ref.top + 4);
        }
      }
      idx += len;
    }
  }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(cv.width, Math.ceil(x1)); y1 = Math.min(cv.height, Math.ceil(y1));
  const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
  const d = x.getImageData(x0, y0, bw, bh).data;
  let cnt = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 127) cnt++;
  const step = Math.max(1, Math.sqrt(cnt / (n * 1.1)));
  const pts = [];
  for (let yy = 0; yy < bh; yy += step) for (let xx = 0; xx < bw; xx += step) {
    const jx = Math.min(bw - 1, Math.max(0, Math.round(xx + (Math.random() - 0.5) * step * 0.7)));
    const jy = Math.min(bh - 1, Math.max(0, Math.round(yy + (Math.random() - 0.5) * step * 0.7)));
    if (d[(jy * bw + jx) * 4 + 3] > 127) pts.push(jx + x0, jy + y0);
  }
  const out = new Float32Array(n * 2), np = Math.max(1, pts.length / 2);
  if (!pts.length) { for (let i = 0; i < n; i++) { out[2 * i] = W / 2; out[2 * i + 1] = VH / 2; } return out; }
  const order = Array.from({ length: np }, (_, i) => i);
  for (let i = np - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = order[i]; order[i] = order[j]; order[j] = t; }
  for (let i = 0; i < n; i++) { const q = order[i % np]; const j = i >= np ? step * 0.45 : 0; out[2 * i] = pts[2 * q] + (Math.random() - 0.5) * j; out[2 * i + 1] = pts[2 * q + 1] + (Math.random() - 0.5) * j; }
  return out;
}

function makeParticles(canvas) {
  let gl = null;
  // 不要求独显（省电），用浏览器默认的 powerPreference
  try { gl = canvas.getContext('webgl', { antialias: false, alpha: true, premultipliedAlpha: true }); } catch { gl = null; }
  if (!gl) return null;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
  const v = sh(gl.VERTEX_SHADER, VS), f = sh(gl.FRAGMENT_SHADER, FS);
  if (!v || !f) return null;
  const pr = gl.createProgram(); gl.attachShader(pr, v); gl.attachShader(pr, f); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return null;
  gl.useProgram(pr);
  const U = {}; ['uRes', 'uT', 'uA', 'uB', 'uK', 'uAmp', 'uAlpha', 'uSize', 'uDpr', 'uBar', 'uWave'].forEach((n) => { U[n] = gl.getUniformLocation(pr, n); });
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  [['aT0', 0], ['aR', 4]].forEach(([n, o]) => { const l = gl.getAttribLocation(pr, n); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 4, gl.FLOAT, false, 32, o * 4); });
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  let N = 0, lost = false, dpr = 1, W = 1, VH = 1;
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
  return {
    get ok() { return !lost; },
    upload(targets, w, h, n) {
      W = w; VH = h; N = n; dpr = Math.min(1.5, window.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(VH * dpr);
      // 每颗 8 个数：开场大字 xy、第 1 组标题 xy、4 个随机数（起步早晚、声波第几列、上下、散开方向）
      const data = new Float32Array(N * 8);
      for (let i = 0; i < N; i++) {
        const o = i * 8;
        data[o] = targets[0][2 * i]; data[o + 1] = targets[0][2 * i + 1]; data[o + 2] = targets[1][2 * i]; data[o + 3] = targets[1][2 * i + 1];
        data[o + 4] = Math.random(); data[o + 5] = Math.random(); data[o + 6] = Math.random(); data[o + 7] = Math.random();
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    },
    clear() { gl.viewport(0, 0, canvas.width, canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); },
    draw(st, t, mob, wave) {
      if (lost) return;
      gl.viewport(0, 0, canvas.width, canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(U.uRes, W, VH); gl.uniform1f(U.uT, t);
      gl.uniform1f(U.uA, st.a); gl.uniform1f(U.uB, st.b); gl.uniform1f(U.uK, st.k); gl.uniform1f(U.uAmp, st.amp); gl.uniform1f(U.uAlpha, st.alpha);
      gl.uniform1f(U.uSize, mob ? 2.2 : 2.5); gl.uniform1f(U.uDpr, dpr); gl.uniform1f(U.uBar, mob ? 5 : 7);
      gl.uniform2f(U.uWave, wave[0], wave[1]);
      gl.drawArrays(gl.POINTS, 0, N);
    }
  };
}

export { sampleText, makeParticles };
