// 官网首页脚本：吉祥物真播（Rive 网页运行库 + 仓库里的 .riv；摆法照 src/motion/mascot-stage.ts 的 createStage）。
// 运行库、wasm、.riv 的地址和每只的画板、状态机、裁切都写在页面的 [data-rive]、[data-riv] 上（build/site_home.mjs 从 catalog.ts 生成），这里不写死。
// 开了省流量（navigator.connection.saveData）或页面上没有这些节点时不加载，一直露静帧。
import { $, $$, quiet, LAST_SC, T, ST } from '/index-kit.js';

/** catalog.ts 的 7 只（顺序同 MASCOT_IDS）；输入框小人是 peek */
const RIVS = $$('[data-riv]');
const MASCOT_IDS = RIVS.map((e) => e.dataset.riv).filter((id) => id !== 'peek');
const DEFS = {};
const MDEF = (id) => DEFS[id] || (DEFS[id] = JSON.parse(RIVS.find((e) => e.dataset.riv === id).dataset.def));
const SAVE = !!(navigator.connection && navigator.connection.saveData);
let riveP = null;
const riveLib = () => riveP || (riveP = new Promise((res, rej) => {
  const rv = $('[data-rive]');
  if (SAVE || !rv) { rej(new Error('rive off')); return; }
  if (window.rive) { res(window.rive); return; }
  const sc = document.createElement('script'); sc.src = rv.dataset.js; sc.crossOrigin = 'anonymous';
  sc.onload = () => { try { window.rive.RuntimeLoader.setWasmUrl(rv.dataset.wasm); window.rive.RuntimeLoader.setWasmFallbackUrl(null); res(window.rive); } catch (e) { rej(e); } };
  sc.onerror = () => rej(new Error('rive'));
  document.head.appendChild(sc);
}));
const RIVB = {};
// .riv 取一次留着，每个实例给一份拷贝
const rivBuf = (id) => {
  if (!RIVB[id]) RIVB[id] = fetch(RIVS.find((e) => e.dataset.riv === id).dataset.src).then((r) => { if (!r.ok) throw new Error('riv'); return r.arrayBuffer(); }).catch((e) => { delete RIVB[id]; throw e; });
  return RIVB[id].then((b) => b.slice(0));
};
/** 一块会动的吉祥物：画布挂在 host 里，换角色就换一个 Rive 实例（真 App 设置页预览也是这样）；没加载好之前 host 上是同一只的静帧 */
function liveMascot(host, multi) {
  const cv = document.createElement('canvas'); cv.className = 'rv-c'; cv.setAttribute('aria-hidden', 'true');
  let r = null, id = null, seq = 0, running = false, at = host, holdFn = null, holdRaf = 0, loaded = false, drawn = false, warm = false, hot = true, asked = null;
  // 真播过一帧才藏静帧（暂停着建好的实例画布还是空的）；一块里放好几只时（设置 › 吉祥物的预览）由外面决定显示哪只
  const shown = () => { if (!multi) at.classList.toggle('live', drawn); };
  const n0 = () => { if (T) T.riveN = (T.riveN || 0) + 1; };
  function place(def) {
    const shut = at.closest('.pg.cv');
    if (shut) shut.classList.remove('cv');
    const bw = at.offsetWidth, bh = at.offsetHeight;
    if (shut) shut.classList.add('cv');
    const [cx, cy, cw, ch] = def.crop, [px, py] = def.pad || [0, 0], sc = Math.min(bw / cw, bh / ch);
    const w = def.size[0] * sc, h = def.size[1] * sc;
    Object.assign(cv.style, { width: w + 'px', height: h + 'px', left: (-(cx + px) * sc + (bw - cw * sc) / 2) + 'px', top: (-(cy + py) * sc + (bh - ch * sc)) + 'px' });
    // 清晰度上限 2 倍（11-26 第五轮，省电）
    const d = Math.min(2, window.devicePixelRatio || 1) * Math.min(1, Math.max(0.5, ST.k));
    cv.width = Math.max(1, Math.round(w * d)); cv.height = Math.max(1, Math.round(h * d));
  }
  function stopHold() { if (holdRaf) { cancelAnimationFrame(holdRaf); holdRaf = 0; } }
  function set(nid) {
    if (nid === id) return;
    id = nid; const my = ++seq; loaded = false; drawn = false; hot = !MDEF(nid).warm;
    if (!multi) at.classList.remove('live');
    stopHold(); holdFn = null;
    if (r) { try { r.cleanup(); } catch { /* 旧的收不掉就算了 */ } r = null; }
    Promise.all([riveLib(), rivBuf(nid)]).then(([lib, buf]) => {
      if (my !== seq) return;
      const def = MDEF(nid);
      at.appendChild(cv); place(def);
      const o = { buffer: buf, canvas: cv, stateMachines: def.sm || 'State Machine 1', autoplay: true, autoBind: def.novm !== true, enableRiveAssetCDN: false,
        onLoad: () => {
          if (my !== seq || !r) return;
          // 一加载就设好的状态机输入（catalog 的 init，和 App 的 mascot-stage.ts 同一份）
          if (def.init) { const ins = r.stateMachineInputs(def.sm) || []; Object.entries(def.init).forEach(([k, v]) => { const inp = ins.find((x) => x.name === k); if (inp) inp.value = v; }); }
          if (def.online) setTimeout(() => { if (my === seq) setBool('onlineOffline', true); }, def.online);
          // 小黑猫睁眼（11-25 第三轮）：cat.riv 的状态机没有输入；真 App（mascot-stage.ts，catalog 的 look）每帧把 Face_CONTROL 节点摆在 rest，这里也摆在 rest；页面不播（run(false)）时这个循环一起停
          if (def.face) {
            const [fn, fx, fy] = def.face;
            holdFn = () => { holdRaf = 0; if (my !== seq || !r || !(running || warm)) return; try { const n = r.artboard && r.artboard.node(fn); if (n) { n.x = fx; n.y = fy; if (T) T.face = true; } } catch { /* 没有这个节点 */ } holdRaf = requestAnimationFrame(holdFn); };
            holdFn();
          }
          Object.keys(want).forEach((k) => setBool(k, want[k]));
          loaded = true; n0();
          const wf = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));
          // 暂停着建好的：先真画两帧再停（第一次画最贵，放在建的时候做，不留到滚动时）
          const fin = () => { warm = false; if (my !== seq || !r) return; drawn = true; shown(); if (!running) { try { r.pause(); } catch { /* 没加载好 */ } stopHold(); } };
          if (!def.warm) { if (running) { drawn = true; shown(); } else { warm = true; wf(fin); } }
          else {
            // 第七轮：米粒播到约 2 秒才第一次画某种效果（现编着色器、读回像素，降速 4 倍下一帧 150ms+），这一下跟着“播了多久”走，不跟着滚动走。
            // 所以只在 300ms 没滚动时播、一滚就停（这期间露出的是静帧），播够 2.6 秒才算热好；热好以后：在屏上就照常播，不在屏上就再等没滚动、浏览器空闲，画两帧停下
            warm = true;
            let played = 0, last = performance.now(), on = true;
            const iv = setInterval(() => {
              if (my !== seq || !r) { clearInterval(iv); return; }
              const now = performance.now(), q = now - LAST_SC >= 300;
              if (on) played += now - last;
              last = now;
              if (q !== on) { on = q; try { if (q) r.play(); else r.pause(); } catch { /* 没加载好 */ } }
              if (played < def.warm) return;
              clearInterval(iv); hot = true;
              if (running) { warm = false; try { r.play(); } catch { /* 没加载好 */ } drawn = true; shown(); }
              else quiet(() => { try { r.play(); } catch { /* 没加载好 */ } wf(fin); });
            }, 100);
          }
        },
        onLoadError: () => { if (my === seq) at.classList.remove('live'); } };
      if (def.ab) o.artboard = def.ab;
      r = new lib.Rive(o);
    }).catch(() => { at.classList.remove('live'); });
  }
  /** 画布挪到另一块（换到另一屏的“现在”卡），同一只不用重新加载 */
  function move(h) { if (h === at) return; at.classList.remove('live'); at = h; if (cv.parentNode) { at.appendChild(cv); shown(); } }
  // 视图模型里的开关量（照 mascot-stage.ts 的 setBool）；没载好就先记着
  const want = {};
  function setBool(name, v) {
    want[name] = v;
    try { const b = r && r.viewModelInstance && r.viewModelInstance.boolean(name); if (b && b.value !== v) b.value = v; } catch { /* 没有这个开关 */ }
  }
  function run(on) {
    if (on === running) return;
    running = on;
    if (!hot) return;   // 还在后台热身（米粒）：播停由热身那边管，这期间露静帧
    if (r && loaded) { try { if (on) r.play(); else r.pause(); } catch { /* 没加载好 */ } }
    if (on && loaded && !drawn) { drawn = true; shown(); }
    if (on && holdFn && !holdRaf) holdRaf = requestAnimationFrame(holdFn);
    if (!on) stopHold();
  }
  /** 要这一只：建实例一下要 100ms 以上，等 300ms 没滚动、浏览器空闲再建（建好以前露静帧） */
  function ask(nid) { if (nid === id || nid === asked) return; asked = nid; quiet(() => { asked = null; set(nid); }); }
  return { set, ask, move, run, setBool, cv, get ok() { return drawn; } };
}

/** 设置 › 吉祥物的预览（第九轮）：只建最后那一只（停在隐私记时，或吉祥物项演示画面定住以后，都等 300ms 没滚动又空闲）；其余露静帧；建好的不拆，换的时候只切显示 */
function livePreview(box) {
  const ms = {}; let queue = [], busy = false;
  function pump() {
    if (busy || !queue.length) return;
    busy = true;
    quiet(() => { const id = queue.shift(); if (id && !ms[id]) { const m = liveMascot(box, true); ms[id] = m; m.set(id); } busy = false; pump(); });
  }
  /** 要建 id 了（第八轮：只建这一只；轮换演示时不建，没建好的露静帧） */
  function want(id) {
    if (ms[id] || queue[0] === id) return;
    queue = [id];
    pump();
  }
  function show(id, on) {
    MASCOT_IDS.forEach((x) => { const m = ms[x]; if (!m) return; m.run(on && x === id); m.cv.classList.toggle('cur', x === id); });
    box.classList.toggle('live', !!(ms[id] && ms[id].ok));
  }
  function pause() { MASCOT_IDS.forEach((x) => { if (ms[x]) ms[x].run(false); }); }
  function stop() { if (queue.length) queue = []; }
  return { want, show, pause, stop };
}

export { MASCOT_IDS, riveLib, liveMascot, livePreview };
