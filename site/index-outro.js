// 官网首页脚本：收尾（镜头钻进大字）和右侧细进度条。
// 只用 el.style 写样式（CSP style-src 'self'）。
import { $, $$, clamp, seg, sm, lerp, f3, put, lang, L } from '/index-kit.js';

/* ================= 收尾：镜头钻进大字（照方向甲） ================= */
function outroCtl() {
  const sec = $('.outro'), pinEl = $('.opin', sec), cover = $('.cover', sec), ow = $('.ow', sec), card = $('.close-card', sec);
  const cctx = cover.getContext('2d');
  let W = 0, VH = 0, dpr = 1, top = 0, glyphs = [], font = '', A = { x: 0, y: 0 }, rIn = 8, sEnd = 40, zc = 1, cardO = -1, lastZ = -1, bgc = null;
  function layout() {
    W = pinEl.clientWidth; VH = pinEl.clientHeight; dpr = Math.min(2, window.devicePixelRatio || 1);
    top = sec.getBoundingClientRect().top + window.scrollY;
    cover.width = Math.round(W * dpr); cover.height = Math.round(VH * dpr);
    const F = Math.min(W < 760 ? (lang === 'ko' ? W * 0.15 : W * 0.29) : (lang === 'ko' ? Math.min(W * 0.12, 180) : Math.min(W * 0.17, 250)), VH * (lang === 'ko' ? 0.17 : 0.27));
    ow.style.fontSize = F + 'px';
    ow.style.letterSpacing = lang === 'ko' ? '-.025em' : '-.01em';
    ow.style.left = '0px'; ow.style.top = '0px';
    const bw = ow.offsetWidth, bh = ow.offsetHeight;
    ow.style.left = Math.round((W - bw) / 2) + 'px'; ow.style.top = Math.round(VH * 0.47 - bh / 2) + 'px';
    const pr = pinEl.getBoundingClientRect();
    const tw = document.createTreeWalker(ow, NodeFilter.SHOW_TEXT), rg = document.createRange();
    glyphs = []; let nd;
    const probe = cctx;
    while ((nd = tw.nextNode())) {
      const pcs = getComputedStyle(nd.parentElement);
      font = `${pcs.fontWeight} ${pcs.fontSize} ${pcs.fontFamily}`;
      probe.font = font;
      const mt = probe.measureText('说'), fa = mt.fontBoundingBoxAscent, fd = mt.fontBoundingBoxDescent, ratio = fa && fd ? fa / (fa + fd) : 0.86;
      Array.from(nd.data).forEach((ch, i) => {
        if (/\s/.test(ch)) return;
        rg.setStart(nd, i); rg.setEnd(nd, i + 1);
        const b = rg.getBoundingClientRect(); if (!b.width) return;
        glyphs.push({ ch, x: b.left - pr.left, top: b.top - pr.top, w: b.width, h: b.height, y: b.top - pr.top + b.height * ratio });
      });
    }
    const g = glyphs.find((q) => q.ch === (lang === 'ko' ? '끝' : '一')) || glyphs[0];
    if (!g) return;
    const Fz = parseFloat(ow.style.fontSize);
    const q = Math.min(1, 140 / Fz), pad = 6;
    const ow2 = Math.ceil(g.w * q) + pad * 2, oh = Math.ceil(g.h * q) + pad * 2;
    const oc = document.createElement('canvas'); oc.width = ow2; oc.height = oh;
    const o = oc.getContext('2d', { willReadFrequently: true });
    o.font = font.replace(/[\d.]+px/, (Fz * q) + 'px'); o.textBaseline = 'alphabetic'; o.fillStyle = '#000';
    o.fillText(g.ch, pad, pad + (g.y - g.top) * q);
    const data = o.getImageData(0, 0, ow2, oh).data;
    const D = new Float32Array(ow2 * oh);
    for (let i = 0; i < ow2 * oh; i++) D[i] = data[i * 4 + 3] > 127 ? 1e9 : 0;
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow2; x++) { const i = y * ow2 + x; if (!D[i]) continue; let v = D[i]; if (x > 0) v = Math.min(v, D[i - 1] + 1); if (y > 0) { v = Math.min(v, D[i - ow2] + 1); if (x > 0) v = Math.min(v, D[i - ow2 - 1] + 1.414); if (x < ow2 - 1) v = Math.min(v, D[i - ow2 + 1] + 1.414); } D[i] = v; }
    for (let y = oh - 1; y >= 0; y--) for (let x = ow2 - 1; x >= 0; x--) { const i = y * ow2 + x; if (!D[i]) continue; let v = D[i]; if (x < ow2 - 1) v = Math.min(v, D[i + 1] + 1); if (y < oh - 1) { v = Math.min(v, D[i + ow2] + 1); if (x < ow2 - 1) v = Math.min(v, D[i + ow2 + 1] + 1.414); if (x > 0) v = Math.min(v, D[i + ow2 - 1] + 1.414); } D[i] = v; }
    let best = -1, bi = -1;
    for (let i = 0; i < ow2 * oh; i++) if (D[i] > 0) { const sc = D[i] - Math.abs((i % ow2) - ow2 / 2) / ow2 * 0.6; if (sc > best) { best = sc; bi = i; } }
    if (bi < 0) { A = { x: g.x + g.w / 2, y: g.top + g.h / 2 }; rIn = Fz * 0.05; } else { A = { x: g.x + ((bi % ow2) - pad + 0.5) / q, y: g.top + (Math.floor(bi / ow2) - pad + 0.5) / q }; rIn = Math.max(2, (D[bi] - 0.7) / q); }
    sEnd = Math.hypot(W, VH) * 0.6 / rIn;
    // 放大到 40 倍时的进度（draw 里 s = sEnd ^ z^1.5）
    zc = sEnd > 40 ? Math.pow(Math.log(40) / Math.log(sEnd), 1 / 1.5) : 1;
    bgc = document.createElement('canvas'); bgc.width = Math.max(2, Math.round(W / 4)); bgc.height = Math.max(2, Math.round(VH / 4));
    const bx = bgc.getContext('2d'); bx.fillStyle = '#f2df4a'; bx.fillRect(0, 0, bgc.width, bgc.height);
    [[0.72, 0.16, 0.6, '#fbf3c4'], [0.1, 0.5, 0.5, '#f7e978']].forEach(([cx, cy, r, col]) => { const gr = bx.createRadialGradient(cx * bgc.width, cy * bgc.height, 0, cx * bgc.width, cy * bgc.height, r * Math.max(bgc.width, bgc.height)); gr.addColorStop(0, col); gr.addColorStop(1, col + '00'); bx.fillStyle = gr; bx.fillRect(0, 0, bgc.width, bgc.height); });
    lastZ = -1;
  }
  function draw(z) {
    if (z === lastZ || !bgc) return; lastZ = z;
    const c = cctx;
    c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, cover.width, cover.height);
    c.drawImage(bgc, 0, 0, cover.width, cover.height);
    const s = Math.exp(Math.log(sEnd) * Math.pow(z, 1.5));
    const e2 = sm(seg(z, 0, 0.85));
    const px = lerp(A.x, W / 2, e2), py = lerp(A.y, VH / 2, e2);
    c.setTransform(dpr * s, 0, 0, dpr * s, dpr * (px - s * A.x), dpr * (py - s * A.y));
    c.font = font; c.textBaseline = 'alphabetic'; c.textAlign = 'left';
    c.globalCompositeOperation = 'destination-out'; c.fillStyle = '#000';
    glyphs.forEach((g) => c.fillText(g.ch, g.x, g.y));
    const ink = 1 - sm(seg(z, 0.03, 0.4));
    if (ink > 0.002) { c.globalCompositeOperation = 'source-over'; c.fillStyle = `rgba(20,21,24,${ink.toFixed(3)})`; glyphs.forEach((g) => c.fillText(g.ch, g.x, g.y)); }
  }
  // 11-26 第五轮：放大到约 40 倍就不再往里钻——整张遮罩淡出、直接换成卡片；卡片在那之前不露字（电脑版大字不和卡片上的字叠在一起）
  function render(sy) {
    const u = (sy - top) / VH;
    const z = sm(seg(u, 0.12, 1.9));
    const f = zc < 0.999 ? sm(seg(z, zc, Math.min(1, zc + 0.06))) : (z >= 1 ? 1 : 0);
    const co = sm(seg(z, zc - 0.12, Math.min(1, zc + 0.03)));
    if (card && co !== cardO) { cardO = co; put(card, 'opacity', f3(co)); }
    if (f >= 1) { put(cover, 'visibility', 'hidden'); return; }
    put(cover, 'visibility', 'visible');
    put(cover, 'opacity', f3(1 - f));
    draw(Math.round(Math.min(z, zc) * 2000) / 2000);
  }
  return { layout, render, get top() { return top; }, get done() { return cardO > 0.3; } };
}

/* ================= 右侧细进度条：四个点是四组，点了跳到那一组开头（11-26 第五轮） ================= */
const RL = [['AI 记录', 'AI 기록'], ['日程提醒', '일정·알림'], ['待办随手记', '할 일·메모'], ['外观', '꾸미기']];
function railCtl(jump) {
  const el = $('.rail'), fill = $('.rail-f', el), dots = $$('button', el);
  let lastG = -2, lastOn = null, lastTt = false, pend = false, seenT = false, fT = 0, hT = 0;
  // 手机上的组名（第八轮）：换组时当前那组亮 1.5 秒；按住或点进度条时四个一起亮，松手 1 秒后收（电脑上一直显示，这两个类不起作用）
  const flash = () => { el.classList.add('fl'); clearTimeout(fT); fT = setTimeout(() => el.classList.remove('fl'), 1500); };
  const hold = (v) => { clearTimeout(hT); if (v) el.classList.add('hold'); else if (el.classList.contains('hold')) hT = setTimeout(() => el.classList.remove('hold'), 1000); };
  el.addEventListener('pointerdown', () => hold(true));
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => el.addEventListener(ev, () => hold(false)));
  dots.forEach((b, g) => b.insertAdjacentHTML('beforeend', `<span class="rl" aria-hidden="true">${L(RL[g][0], `<span lang="ko">${RL[g][1]}</span>`)}</span>`));
  dots.forEach((b, g) => b.addEventListener('click', () => { const y = jump(g); if (y != null) window.scrollTo(0, y); }));
  return {
    place(fr) { dots.forEach((b, g) => put(b, 'top', (clamp(fr[g]) * 100).toFixed(2) + '%')); },
    set(on, p, g, tt) {
      if (on !== lastOn) { el.classList.toggle('on', on); lastOn = on; }
      if (!!tt !== lastTt) { el.classList.toggle('tt', !!tt); lastTt = !!tt; }
      put(fill, 'transform', `scaleY(${f3(clamp(p))})`);
      if (g !== lastG) {
        lastG = g; if (g >= 0) { pend = true; seenT = false; } dots.forEach((b, i) => { b.classList.toggle('cur', i === g); if (i === g) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); });
      }
      // 第九轮：换组后先等这一组的大标题出现过一次，它让开了才亮（不会先露一下再被收掉）；减少动态版没有会动的大标题（tt 不传），换组就亮
      if (tt || tt === undefined) seenT = true;
      if (tt) { if (el.classList.contains('fl')) { clearTimeout(fT); el.classList.remove('fl'); } }
      else if (on && pend && seenT) { pend = false; flash(); }
    }
  };
}

export { outroCtl, railCtl };
