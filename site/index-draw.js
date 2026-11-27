// 官网首页脚本：一台样机的演示控制（每一项按剧本切换画面状态、画手指）。键盘、月历、边缘划动和多端的几屏都由 build/site_home.mjs 构建时写在页面里。
// 只用 el.style 写样式（CSP style-src 'self'）。
import { $, $$, clamp, seg, sm, eo, eio, lerp, idle, f3, put, lang, DEMO, T } from '/index-kit.js';

function phoneCtl(ph, lazy) {
  const scr = $('.scr', ph), fg = $('.fg', ph), fgd = $('.fg-d', ph), fgr = $('.fg-r', ph), tb = $('.tb', ph);
  const tabs = $$('.tb > span:not(.drop)', ph);
  const screens = {};
  $$('.pg', ph).forEach((p) => { screens[p.dataset.s] = p; if (lazy && !p.classList.contains('on')) p.classList.add('cv'); });
  let cur = null, keys = [], evs = [], ce = 0, lastNow = 0, lastPush = 0, dirty = false;
  const order = Object.keys(screens), near = (a, b) => !!b && Math.abs(order.indexOf(a) - order.indexOf(b)) <= 1;
  const mem = {};   // 每一屏离开时播到哪一刻、什么时候离开的
  const off = (el) => { let x = 0, y = 0; while (el && el !== scr) { x += el.offsetLeft; y += el.offsetTop; el = el.offsetParent; } return { x, y }; };
  const center = (el) => { const o = off(el); return { x: o.x + el.offsetWidth / 2, y: o.y + el.offsetHeight / 2 }; };
  const find = (root, sel) => {
    if (sel === '') return root;
    sel = sel.replace('%o', lang === 'ko' ? 'zh' : 'ko');
    if (sel[0] === '@') return $(sel.slice(1), ph);
    return $(sel, root);
  };
  function prep(name) {
    const d = DEMO[name], root = screens[name];
    evs = d.ev.map((e) => ({ e, el: e[0] === 'drag' ? find(root, e[6] || e[3]) : find(root, e[3]) }));
    keys = d.ev.filter((e) => e[0] === 'tap' || e[0] === 'hold' || e[0] === 'drag' || e[0] === 'swipe').map((e) => {
      const mv = e[0] === 'drag' || e[0] === 'swipe';
      return { t0: e[1], t1: e[2], dx: mv ? e[4] : 0, dy: mv ? e[5] : 0, arc: e[0] === 'swipe' ? e[6] : 0, hold: e[0] === 'hold', drag: mv, el: find(root, e[3]), p0: null, p1: null };
    }).filter((k) => k.el);
    measure();
  }
  // 量手指要点的位置（看不见的就留着上一次量的）：换屏、改窗口大小、画面状态（类名）变了以后才量，位置只会在这几种时候变（拖动、打字都不改 offset）
  function measure() {
    dirty = false;
    keys.forEach((k) => {
      if (!k.el || (k.p0 && k.el.offsetParent === null)) return;
      const p = center(k.el);
      k.p0 = p; k.p1 = { x: p.x + k.dx, y: p.y + k.dy };
    });
  }
  function show(name, now) {
    if (cur === name) return;
    if (cur) {
      mem[cur] = { e: ce, at: now }; const o = screens[cur]; o.classList.remove('on', 'rst'); clearState(cur);
      if (lazy) setTimeout(() => { if (!near(o.dataset.s, cur)) o.classList.add('cv'); }, 220);   // 淡出完了再收起（前后相邻的两屏留着）
    }
    cur = name;
    const s = screens[name];
    s.classList.remove('cv');
    // 前后相邻两屏趁空闲先排好（换屏那一帧不用现排一整屏）
    if (lazy) idle(() => { if (cur !== name) return; const i = order.indexOf(name); [order[i - 1], order[i + 1]].forEach((x) => { if (x) screens[x].classList.remove('cv'); }); }, 600);
    // 4 秒内回到刚看过的一项（在两项交界来回滑）：从离开时播到的那一刻接着播，里面的东西直接到位，不从 0 重播
    const m = mem[name], back = !!m && now - m.at < 4000;
    if (back) { s.classList.add('nox-in'); requestAnimationFrame(() => requestAnimationFrame(() => s.classList.remove('nox-in'))); }
    s.classList.add('on');
    const ti = +s.dataset.tab;
    ph.classList.toggle('notab', ti < 0);
    if (ti >= 0) { put(tb, '--ti', String(ti)); tabs.forEach((t, i) => t.classList.toggle('on', i === ti)); }
    prep(name);
    ce = back ? m.e : 0; lastNow = 0; lastPush = 0;
  }
  function clearState(name) {
    const d = DEMO[name], root = screens[name];
    d.ev.forEach((e) => {
      const el = e[0] === 'drag' ? find(root, e[6] || e[3]) : find(root, e[3]);
      if (!el) return;
      if (e[0] === 'c') el.classList.remove(e[4]);
      else if (e[0] === 'type') put(el, '--p', '0');
      else if (e[0] === 'drag' && e[6]) { put(el, 'transform', ''); el.classList.remove('drag'); }
      if (e[0] === 'type' && el.parentElement) el.parentElement.classList.remove('typing');
    });
    $$('.pr', ph).forEach((x) => x.classList.remove('pr'));
  }
  function finger(e) {
    if (!keys.length) { put(fg, 'opacity', '0'); return; }
    if (dirty) measure();
    const first = keys[0], last = keys[keys.length - 1];
    let x, y, o = 1, s = 1, d = 0, r = -1, hold = false;
    const enter = { x: first.p0.x + 40, y: first.p0.y + 120 };
    if (e < first.t0) {
      const k = eio(seg(e, first.t0 - 0.55, first.t0 - 0.05));
      x = lerp(enter.x, first.p0.x, k); y = lerp(enter.y, first.p0.y, k); o = sm(seg(e, first.t0 - 0.6, first.t0 - 0.3)); s = 1.25 - 0.25 * k;
    } else if (e > last.t1) {
      const k = eio(seg(e, last.t1 + 0.3, last.t1 + 0.85));
      x = lerp(last.p1.x, last.p1.x + 40, k); y = lerp(last.p1.y, last.p1.y + 120, k); o = 1 - sm(seg(e, last.t1 + 0.35, last.t1 + 0.8));
      r = seg(e, last.t1, last.t1 + 0.4);
    } else {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (e < k.t0) {
          const p = keys[i - 1], a = Math.max(p.t1 + 0.12, k.t0 - 0.5), q = eio(seg(e, a, k.t0 - 0.04));
          x = lerp(p.p1.x, k.p0.x, q); y = lerp(p.p1.y, k.p0.y, q); r = seg(e, p.t1, p.t1 + 0.4);
          if (k.t0 - p.t1 > 0.9) o = clamp(1 - sm(seg(e, p.t1 + 0.25, p.t1 + 0.45)) + sm(seg(e, k.t0 - 0.45, k.t0 - 0.2)));
          break;
        }
        if (e <= k.t1) {
          const q = k.drag ? eio(seg(e, k.t0 + 0.1, k.t1 - 0.05)) : 0;
          x = lerp(k.p0.x, k.p1.x, q); y = lerp(k.p0.y, k.p1.y, q) - k.arc * Math.sin(Math.PI * q);
          const pin = sm(seg(e, k.t0, k.t0 + 0.08));
          s = 1 - 0.2 * pin; d = pin; hold = k.hold && e > k.t0 + 0.12; break;
        }
      }
    }
    put(fg, 'opacity', f3(o));
    put(fg, 'transform', `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) scale(${f3(s)})`);
    put(fgd, 'opacity', f3(d));
    if (r > 0 && r < 1) { put(fgr, 'opacity', f3(0.8 * (1 - r))); put(fgr, 'transform', `scale(${f3(0.8 + 1.7 * eo(r))})`); } else put(fgr, 'opacity', '0');
    fg.classList.toggle('hold', hold);
    keys.forEach((k) => { if (k.el) k.el.classList.toggle('pr', e >= k.t0 && e <= k.t1 && !k.drag); });
  }
  function apply(e, live) {
    evs.forEach(({ e: v, el }) => {
      if (!el) return;
      if (v[0] === 'c') { const on = e >= v[1] && e < v[2]; if (el.classList.contains(v[4]) !== on) { el.classList.toggle(v[4], on); dirty = true; } }
      else if (v[0] === 'type') {
        const p = seg(e, v[1], v[2]), pe = el.parentElement, ty = e >= v[1];
        put(el, '--p', p.toFixed(3));   // 字一个个出来用的是 clip-path，不改排版
        if (pe && pe.classList.contains('typing') !== ty) { pe.classList.toggle('typing', ty); dirty = true; }
      }
      else if (v[0] === 'drag' && v[6]) {
        const q = eio(seg(e, v[1] + 0.1, v[2] - 0.05));
        const on = e >= v[1] && e < v[9];
        el.classList.toggle('drag', e >= v[1] && e <= v[2]);
        put(el, 'transform', on ? `translate3d(${(v[7] * q).toFixed(1)}px,${(v[8] * q).toFixed(1)}px,0)` : '');
      }
    });
    if (live) finger(e); else put(fg, 'opacity', '0');
  }
  // 演示时间：时钟一直往后走；往下滚（push 变大）时至少推到 push，停手就照时钟接着播，播完一遍从头循环
  function run(now, push) {
    if (!cur) return;
    const d = DEMO[cur];
    const fz = T && T.freeze;
    // 截图用：freeze = true 停在结果画面；freeze = 秒数 停在这一刻（手指照画）
    if (typeof fz === 'number') { apply(Math.min(fz, d.dur - 0.4), true); return; }
    if (fz) { apply(d.still, false); return; }
    ce += lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
    lastNow = now;
    if (push !== undefined) { if (push > lastPush + 1e-4) ce = Math.max(ce, push); lastPush = push; }
    const L = loopLen(d);
    if (ce >= L) { ce %= L; snap(); }
    apply(ce, true);
  }
  // 一遍 = 剧本长度 + 结果画面多停 0.6 秒，最长 6 秒
  const loopLen = (d) => Math.min(6, d.dur + 0.6);
  // 从头再来时，这一屏里的东西直接回到开头的样子（不播反向过渡、不闪空白）
  function snap() { const s = screens[cur]; if (!s) return; s.classList.add('nox-in'); requestAnimationFrame(() => requestAnimationFrame(() => s.classList.remove('nox-in'))); }
  /** 每次进屏都从 0 秒开始播（隐私那一节） */
  function restart(name, now) {
    if (cur) { clearState(cur); screens[cur].classList.remove('on'); }
    cur = null; delete mem[name];
    show(name, now);
    ce = 0; lastNow = 0; lastPush = 0;
  }
  /** 第一下点在哪（减少动态效果时画那一圈标记用；屏幕坐标） */
  function firstTap() { const k = keys.find((q) => q.p0); return k ? k.p0 : null; }
  function still(name) {
    ph.classList.add('nox');
    show(name, 0);
    apply(DEMO[name].still, false);
  }
  /** 停在某一屏的开头（首屏底下露出来的那台手机） */
  function pose(name, now) { show(name, now); ce = 0; lastNow = 0; lastPush = 0; apply(0, false); }
  function remeasure() { if (cur) prep(cur); }
  function stop() { put(fg, 'opacity', '0'); lastNow = 0; }
  return { show, run, pose, still, remeasure, stop, restart, firstTap, screen: (n) => screens[n], get cur() { return cur; }, get e() { return ce; } };
}

export { phoneCtl };
