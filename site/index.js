// 官网首页脚本入口：启动（动起来，或减少动态效果时一屏一屏静态排开）、页面下半段的进屏淡入、隐私节和多端那一节的手机。
// 隐私节、多端那几台手机的画面由 build/site_home.mjs 构建时写在页面里，这里只管播和摆放。只用 el.style 写样式（CSP style-src 'self'）。
import { doc, RM, $, $$, clamp, eio, idle, put, ITEMS, T, ST } from '/index-kit.js';
import { phoneCtl } from '/index-draw.js';
import { railCtl } from '/index-outro.js';
import { initFx, stageGeom } from '/index-fx.js';

/** 从样机抄一台（减少动态效果时每项一台）：去掉动起来时写上的类名、样式、吉祥物画布 */
function cleanClone(ph) {
  ph.classList.remove('rig', 'ent', 'notab', 'nox'); ph.removeAttribute('style');
  $$('.rv-c', ph).forEach((x) => x.remove()); $$('.live', ph).forEach((x) => x.classList.remove('live'));
  return ph;
}

/* ================= 减少动态效果 / 出错的退路：一屏一屏静态排开（每项抄两台手机，只有这时才要，所以不写进页面） ================= */
function buildStatic() {
  doc.classList.add('rm');
  doc.classList.remove('fx');
  const host = $('.static'), film = $('#film');
  const proto = $('.rig', film), titles = $$('.gt', film), caps = $$('.cap', film);
  const cards = [];
  for (let g = 0; g < 4; g++) {
    const sec = document.createElement('section');
    sec.className = 'st-g';
    const h = document.createElement('h2');
    h.innerHTML = titles[g].innerHTML;
    h.setAttribute('aria-hidden', 'true');   // 读屏读页面里那份只给读屏的列表（.sr-film），这里的字只给眼睛看
    sec.appendChild(h);
    ITEMS.forEach(([name, gg], i) => {
      if (gg !== g) return;
      const row = document.createElement('div'); row.className = 'st-i';
      const cap = caps[i].cloneNode(true);
      const box = document.createElement('div'); box.className = 'st-ph'; box.setAttribute('aria-hidden', 'true');
      const ph = cleanClone(proto.cloneNode(true));
      $$('.pg', ph).forEach((p) => { if (p.dataset.s !== name) p.remove(); });
      box.appendChild(ph); row.append(cap, box); sec.appendChild(row);
      cards.push([ph, name]);
    });
    host.appendChild(sec);
  }
  $$('.gt', film).forEach((x) => x.remove());
  heroPhone(film);
  cards.forEach(([ph, name]) => rmSteps(ph.parentNode, ph, name));
  playOnce($$('.st-ph'));
  // 右侧进度条（四个点跳到四组）、右下角“看演示”小胶囊：减少动态效果时一样有，按页面位置算
  const secs = $$('.st-g', host), rail = railCtl((g) => Math.round(secs[g].getBoundingClientRect().top + window.scrollY));
  const dock = $('.dock'), heroEl = $('.hero'), card = $('.close-card');
  const upd = () => {
    const y = window.scrollY, vh = window.innerHeight, tops = secs.map((x) => x.getBoundingClientRect().top + y);
    const t0 = tops[0], span = Math.max(1, host.getBoundingClientRect().bottom + y - t0), mid = y + vh * 0.5;
    let g = 0; tops.forEach((tp, i) => { if (mid >= tp) g = i; });
    rail.place(tops.map((tp) => (tp - t0) / span));
    rail.set(mid >= t0 && mid < t0 + span, (mid - t0) / span, g);
    const cr = card.getBoundingClientRect();
    dock.classList.toggle('on', heroEl.getBoundingClientRect().bottom < 0 && !(cr.top < vh && cr.bottom > 0));
    dock.classList.toggle('sm', $('#dev').getBoundingClientRect().top < vh && $('#faq').getBoundingClientRect().bottom > 0);
  };
  window.addEventListener('scroll', upd, { passive: true }); window.addEventListener('resize', upd); upd();
  if (T) Object.assign(T, { mode: 'static', gl: false });
}

/* 减少动态效果时首屏那台手机：位置、大小和动起来时首屏露出的一样（在 html.fx 的样式下量，量完马上去掉；
   说明和小标签留在页面里藏着，只为量版面），只留输入那一屏，静止不动；窗口大小变了重量一次 */
function heroPhone(film) {
  const box = $('.rig-box', film), rig = box && $('.rig', box);
  if (!rig) return;
  $$('.pg', rig).forEach((p) => { if (p.dataset.s !== 'type') p.remove(); });
  // 动起来那段出错退到这里时，清掉它写过的样式（不经 put 的缓存，直接写）
  box.removeAttribute('style'); rig.removeAttribute('style');
  rig.classList.remove('ent');
  const place = () => {
    doc.classList.add('fx');
    const { k, phC, heroPh } = stageGeom(film);
    doc.classList.remove('fx');
    box.style.transform = `translate3d(${phC.x.toFixed(1)}px,${phC.y.toFixed(1)}px,0)`;
    rig.style.transform = `translate3d(${heroPh.dx.toFixed(1)}px,${heroPh.dy.toFixed(1)}px,0) scale(${k.toFixed(4)})`;
  };
  place();
  phoneCtl(rig).pose('type', 0);
  window.addEventListener('resize', place);
}

function initReveal() {
  const rv = $$('.rv');
  if (!('IntersectionObserver' in window)) { rv.forEach((x) => x.classList.add('in')); return; }
  const io = new IntersectionObserver((es) => es.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { threshold: 0.12 });
  rv.forEach((x) => io.observe(x));
  // 多端这一节：圆角画面跟滚动展开（苹果 inset(0 6.25% round 28px) → inset(0)）
  const bg = $('.dev .sec-bg'), dev = $('.dev');
  if (!RM && bg) {
    const upd = () => { const r = dev.getBoundingClientRect(), vh = window.innerHeight; const pe = eio(clamp((vh - r.top) / (0.75 * vh))); const ins = ((1 - pe) * 6.25).toFixed(3), rad = ((1 - pe) * 28).toFixed(2); const c = `inset(0 ${ins}% 0 ${ins}% round ${rad}px)`; put(bg, 'clipPath', c); put(bg, 'webkitClipPath', c); };
    window.addEventListener('scroll', upd, { passive: true }); upd();
  }
}

/** 减少动态效果：每项三步——操作前 → 点的地方一圈标记 → 操作后；只用淡入淡出，进屏播一遍 1.2 秒就停 */
function rmSteps(box, ph, name) {
  const after = ph.cloneNode(true); after.classList.add('rm-b'); box.appendChild(after);
  ph.classList.add('nox');
  const a = phoneCtl(ph), b = phoneCtl(after);
  a.pose(name, 0); b.still(name);
  const p = a.firstTap(), sk = parseFloat(getComputedStyle(box).getPropertyValue('--sk')) || 0.66;
  if (p) { const mk = document.createElement('i'); mk.className = 'rmk'; mk.setAttribute('aria-hidden', 'true'); mk.style.left = ((16 + p.x) * sk).toFixed(1) + 'px'; mk.style.top = ((16 + p.y) * sk).toFixed(1) + 'px'; box.appendChild(mk); }
}
function playOnce(boxes) {
  if (!('IntersectionObserver' in window)) { boxes.forEach((x) => x.classList.add('go')); return; }
  const io = new IntersectionObserver((es) => es.forEach((en) => { if (en.isIntersecting && en.intersectionRatio >= 0.5) { en.target.classList.add('go'); io.unobserve(en.target); } }), { threshold: [0, 0.5] });
  boxes.forEach((x) => io.observe(x));
}

/* 带 #锚点进来（演示页页顶点 #dev、#safe、#faq）：多端那一节的高度是脚本后定的，Safari 没有滚动锚定，定下以后落点会偏
   （11-26 WebKit 实测 #safe 偏 168px）。高度定下后再滚一次到锚点；进来以后自己滚过、点过就不动 */
let userMoved = false;
['wheel', 'touchstart', 'keydown', 'pointerdown'].forEach((ev) => window.addEventListener(ev, () => { userMoved = true; }, { passive: true, once: true }));
function hashLanding() {
  const id = decodeURIComponent(location.hash.slice(1)), el = id && document.getElementById(id);
  if (el && !userMoved) el.scrollIntoView({ block: 'start', behavior: 'instant' });
}

/* 多端那一节：iPhone（今天）、网页版（今天）、Windows 窗口（随手记）；后两台是真网页版截图，写在页面里；按宽度整块缩放摆成一行 */
function initDev() {
  const host = $('.dvs'), ph = host && $('.dv-ph .ph', host);
  if (!ph || host.dataset.ok) return;
  host.dataset.ok = '1';
  phoneCtl(ph).pose('type', 0);
  // 顺序和下面三行说明一致：iPhone、网页版、Windows 版
  const NAT = [[425, 884], [1120, 746], [900, 601]], els = $$('.dvw', host), list = $('.devs');
  const lay = () => {
    const Wc = host.clientWidth;
    let pos;
    if (Wc >= 760) {
      const g = 28, s = (Wc - 2 * g - 110) / (NAT[0][0] + NAT[1][0] + NAT[2][0]), Hm = Math.max.apply(null, NAT.map((n) => n[1])) * s;
      let x = 0;
      pos = NAT.map((n, i) => { const q = [x, Hm - n[1] * s, s]; x += n[0] * s + g + (i === 0 ? 110 : 0); return q; });
      host.style.height = Hm.toFixed(1) + 'px';
      list.style.gridTemplateColumns = NAT.map((n, i) => (n[0] * s + (i === 0 ? 110 : 0)).toFixed(1) + 'px').join(' ');
    } else {
      const s0 = Wc * 0.88 / 1120, s1 = Wc * 0.62 / 900, s2 = Wc * 0.26 / 425;
      // 手机：从左到右 iPhone（压在最前）、网页版（右上）、Windows（右下）
      pos = [[0, NAT[1][1] * s0 * 0.3, s2], [Wc - 1120 * s0, 0, s0], [Wc - 900 * s1, NAT[1][1] * s0 * 0.58, s1]];
      host.style.height = Math.max(pos[2][1] + NAT[2][1] * s1, pos[0][1] + 884 * s2).toFixed(1) + 'px';
      list.style.gridTemplateColumns = '';
    }
    els.forEach((el, i) => { el.style.transform = `translate(${pos[i][0].toFixed(1)}px,${pos[i][1].toFixed(1)}px) scale(${pos[i][2].toFixed(4)})`; });
    if (ST.relay) ST.relay();   // 这一节高度变了，收尾那段的位置要重算
  };
  lay();
  hashLanding();
  window.addEventListener('resize', lay);
}

/* 隐私那一节的手机：隐私记解锁那一屏，进屏才播、出屏停；减少动态效果时停在解锁后的画面 */
function initSafe() {
  const box = $('.safe-ph'), ph = box && $('.ph', box);
  if (!ph || box.dataset.ok) return;
  box.dataset.ok = '1';
  if (RM) { rmSteps(box, ph, 'vsafe'); return; }
  const ctl = phoneCtl(ph);
  ctl.pose('vsafe', 0);
  let vis = false, raf = 0;
  const tick = (now) => {
    raf = 0;
    if (!vis) { ctl.stop(); return; }
    ctl.run(now);
    raf = requestAnimationFrame(tick);
  };
  if (!('IntersectionObserver' in window)) { vis = true; ctl.restart('vsafe', performance.now()); raf = requestAnimationFrame(tick); return; }
  // 露出 60% 以上才开始播，每次进屏都从 0 秒播
  new IntersectionObserver((es) => {
    const v = es[es.length - 1].intersectionRatio >= 0.6;
    if (v && !vis) ctl.restart('vsafe', performance.now());
    vis = v;
    if (vis && !raf) raf = requestAnimationFrame(tick);
  }, { threshold: [0, 0.6] }).observe(box);
  if (T) T.safe = () => ctl.e;
}

function boot() {
  $$('a.to-inv').forEach((a) => a.addEventListener('click', () => { const d = $('#faq-invite'); if (d) d.open = true; }));
  if (RM) { initSafe(); initDev(); initReveal(); buildStatic(); return; }
  initReveal();
  try { initFx(); } catch (err) {
    // 动起来那段出错：和减少动态效果一样静态排开，隐私节、多端照常
    doc.classList.remove('fx');
    try { buildStatic(); } catch { /* 静态也不行就只留开场 */ }
    if (T) Object.assign(T, { mode: 'static', error: String(err) });
  }
  // 首帧以后、浏览器空闲时：隐私节手机 → 多端三台
  idle(() => { initSafe(); idle(initDev); });
}
const start = () => requestAnimationFrame(() => setTimeout(boot, 0));
if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
