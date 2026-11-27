// 官网首页脚本：动起来的整段（钉住滚动、四组时间轴、吉祥物按需加载）。
// 只用 el.style 写样式（CSP style-src 'self'）。
import { doc, $, $$, clamp, seg, sm, eo, eio, lerp, eOut, f3, SC, put, DEMO, ITEMS, T, ST } from '/index-kit.js';
import { phoneCtl } from '/index-draw.js';
import { sampleText, makeParticles } from '/index-gl.js';
import { MASCOT_IDS, riveLib, liveMascot, livePreview } from '/index-rive.js';
import { outroCtl, railCtl } from '/index-outro.js';

// 首屏的字最靠右到哪（电脑版首屏的手机放右半边，不压字）
function textRight(pin, hero) {
  const pr = pin.getBoundingClientRect(), rg = document.createRange();
  let r = 0;
  [$('h1', hero), $('.lede', hero), $('.alt-t', hero), $('.cta-note', hero)].forEach((el) => {
    if (!el) return;
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let nd;
    while ((nd = tw.nextNode())) { rg.selectNodeContents(nd); Array.from(rg.getClientRects()).forEach((b) => { if (b.width) r = Math.max(r, b.right - pr.left); }); }
  });
  $$('.cta .btn', hero).forEach((b) => { const q = b.getBoundingClientRect(); if (q.width) r = Math.max(r, q.right - pr.left); });
  return r;
}

/** 整段的版面：摆好说明、小标签，算出手机缩放 k、讲四组时手机的中心 phC、首屏手机相对 phC 的偏移 heroPh。
    要在 html.fx 的样式下量；减少动态效果时首屏那台静止的手机也用这一份，位置大小和动起来时的首屏一致 */
function stageGeom(film) {
  const pin = $('.pin', film), Hs = $('.frame', film).clientHeight, W = pin.clientWidth, mob = W < 900;
  const caps = $$('.cap', film), labs = $$('.glab', film);
  // 电脑版：文字栏 520px + 72px + 手机，整块居中（收掉中间的空沟）；手机版：文字在上，手机在下
  const colL = mob ? 20 : Math.max(48, (W - 1240) / 2);
  const cw = mob ? W - 40 : Math.min(520, W * 0.42);
  caps.forEach((c) => { c.style.left = colL + 'px'; c.style.width = cw + 'px'; });
  const capH = Math.max.apply(null, caps.map((c) => c.offsetHeight));
  const labH = Math.max.apply(null, labs.map((l) => l.offsetHeight));
  let ly, cy, k, phC, heroPh;
  if (mob) { ly = Math.round(Math.max(52, Hs * 0.06)); cy = ly + labH + 10; }
  else { ly = Math.max(64, Math.round((Hs - (labH + 18 + capH)) / 2)); cy = ly + labH + 18; }
  caps.forEach((c) => { c.style.top = cy + 'px'; });
  labs.forEach((l) => { l.style.left = colL + 'px'; l.style.top = ly + 'px'; });
  if (mob) {
    // 底下留出右下角“看演示”小胶囊的位置，手机不被它盖住
    const top = cy + capH + 10, avail = Hs - top - 66;
    k = Math.max(0.4, Math.min(avail / 884, (W - 40) / 425, 0.86));
    phC = { x: W / 2, y: top + 884 * k / 2 };
    heroPh = { dx: 0, dy: Hs * 0.72 + 884 * k / 2 - phC.y };   // 首屏：手机上沿露出约 28% 屏高
  } else {
    k = Math.max(0.5, Math.min(Hs * 0.88 / 884, 0.95));
    const pw = 425 * k;
    phC = { x: Math.min(colL + cw + 96 + pw / 2, W - 48 - pw / 2), y: Hs / 2 };
    // 首屏：手机放右半边、从底下露出上面一大截，不压首屏的字
    const hx = Math.min(W - 24 - pw / 2, Math.max(phC.x, textRight(pin, $('.hero', film)) + 48 + pw / 2));
    heroPh = { dx: hx - phC.x, dy: Hs * 0.34 + 884 * k / 2 - phC.y };
  }
  return { colL, ly, labH, k, phC, heroPh };
}

/* ================= 动起来的整段 ================= */
function initFx() {
  const film = $('#film'), pin = $('.pin', film), frame = $('.frame', film), hero = $('.hero', film), h1 = $('h1', hero);
  const nav = $('.nav', hero), heroFoot = $('.hero-foot', hero);
  const titles = $$('.gt', film), labs = $$('.glab', film), caps = $$('.cap', film), rigBox = $('.rig-box', film), rig = $('.rig', film), glow = $('.glow', film);
  const pcan = $('.pc', film), LAY = [null, $('.xb', film), $('.xw', film), $('.xp', film)];
  const dock = $('.dock');
  // 每组怎么进场，四种各不相同（11-25 负责人：“除了开头的粒子效果，后面用到的粒子效果全部改成其他动态效果”“4个大板块的背景的各不相同，切进去的动画效果也各不相同”）：
  // 1 gl：开场声波聚成标题（全片唯一一段粒子），柠檬黄底；2 push：浅一档的柠檬黄底整页从右推进来，大字同时从右边滑一小段到位、淡入；
  // 3 wipe：再浅一档的柠檬黄底斜着一整块从左扫过去，大字同时从下往上浮出来；4 open：大字先出来，柠檬淡黄的圆角画面在它后面从中间放大铺满
  // 11-26 第五轮：标题跟底色同时进场（第 4 组标题先出来），组与组之间不留空屏，转场不到 1 屏；停在哪一帧都是完整画面
  const TR = ['gl', 'push', 'wipe', 'open'];
  doc.classList.add('fx');
  const closeCard = $('.close-card');
  if (closeCard) closeCard.classList.remove('rv');   // 收尾卡片的显隐交给收尾那一段（跟着放大进度出来）
  const phone = phoneCtl(rig, true);
  const outro = outroCtl();
  // 吉祥物真播三块：今天页“现在”卡（米粒，跟着换到当前这一屏）、输入框小人、设置 › 吉祥物的预览（跟着选中的换）；当前这一屏没有的那块整个收掉
  const pvBox = $('.s-masc .mpv', rig), firstMs = $('.nc .ms', rig);
  const liveN = firstMs ? liveMascot(firstMs) : null, liveP = pvBox ? livePreview(pvBox) : null, MASC_I = ITEMS.findIndex((x) => x[0] === 'masc');
  const firstPk = $('.pk-rv', rig), liveK = firstPk ? liveMascot(firstPk) : null;
  // 今天页“现在”卡的米粒、输入框小人：第一次滚到快看见第 1 组演示时才下载 Rive 运行库、wasm、.riv 并建好（暂停着），用到时直接播；
  // 首屏那台手机只露静帧，开页不下载这些。开了省流量的一直露静帧（riveLib 不加载）
  let riveAsked = false;
  const askRive = () => { riveAsked = true; riveLib().then(() => { if (liveN) liveN.ask('15'); if (liveK) liveK.ask('peek'); }).catch(() => {}); };
  let pkIdle = 0;
  let P = null;              // 粒子
  let W = 0, VH = 0, Hs = 0, mob = true, k = 0.7, phC = { x: 0, y: 0 }, heroPh = { dx: 0, dy: 0 }, filmTop = 0;
  let TT = [], LB = [], IT = [], TL = null, wave = [0, 0], secY = [1e9, 0];
  // 多端、隐私、常见问题这一段在页面上的上下沿（小胶囊在这一段收小）
  const secPos = () => { const a = $('#dev'), b = $('#faq'); if (a && b) secY = [a.getBoundingClientRect().top + window.scrollY, b.getBoundingClientRect().bottom + window.scrollY]; };
  // 进度条上的点：第 1 组停在粒子聚成实字那一刻，第 2～4 组停在大字刚到位那一刻（都是完整画面）
  const jumpAt = (G) => (G.g === 0 ? G.X[1] : G.A[1] + 0.05);
  const rail = railCtl((g) => (TL ? Math.round(filmTop + jumpAt(TL.groups[g]) * VH) : null));

  /* 时间轴（单位：屏）：开场 1 屏，然后四组；每项 1 屏（第五轮不变）。
     第 1 组：粒子聚成标题 → 换成文字 → 缩成左上的小标签 → 手机进来；第 2～4 组：标题跟底色同时进场（半屏）→ 缩成小标签、手机同时进来 → 第一项 */
  function buildTL() {
    const groups = [];
    let st = 0.85;
    for (let g = 0; g < 4; g++) {
      const items = ITEMS.map((it, i) => ({ i, name: it[0], g: it[1] })).filter((it) => it.g === g);
      const G = g === 0
        ? { g, st, A: [st, st + 0.75], X: [st + 0.8, st + 0.95], K: [st + 0.95, st + 1.4], P: [st + 1.12, st + 1.5], i0: st + 1.45, items }
        : { g, st, A: [st, st + 0.5], X: [st + 0.5, st + 0.5], K: [st + 0.55, st + 0.9], P: [st + 0.68, st + 0.98], i0: st + 0.9, items };
      items.forEach((it, j) => { it.a = G.i0 + j; it.b = it.a + 1; });
      G.end = G.i0 + items.length;
      // 11-26 负责人：“这一块切屏效果换掉，像一个大空白页”→ 选“接力，不留空屏”：手机、最后一句、小标签跨过组界才退，
      // 下一组的大字在它们还在时就进来（手机的透明度另外压在 1 - 大字透明度以下，两块只在交替那一下重叠）
      G.out = [G.end - 0.05, G.end + 0.25];
      groups.push(G);
      st = G.end;
    }
    const end = groups[3].end + 0.2;
    // 最后一组不退场：整段钉住结束后舞台带着手机和最后一句往上走，多端那一节从下面接上来
    groups[3].out = [end + 1, end + 1.2];
    return { groups, end };
  }

  function fitTitle(el) {
    el.style.transform = 'none'; el.style.left = '0px'; el.style.top = '0px';
    const base = mob ? Math.min(W * 0.155, Hs * 0.09) : Math.min(W * 0.085, Hs * 0.15, 150);
    el.style.fontSize = base + 'px';
    const w = el.offsetWidth, lim = W - (mob ? 98 : 120);
    if (w > lim) el.style.fontSize = (base * lim / w) + 'px';
    const bw = el.offsetWidth, bh = el.offsetHeight;
    const bx = Math.round(mob ? 18 + (lim - bw) / 2 : (W - bw) / 2), by = Math.round(Hs * (mob ? 0.44 : 0.47) - bh / 2);
    el.style.left = bx + 'px'; el.style.top = by + 'px';
    return { bx, by, bw, bh, F: parseFloat(el.style.fontSize) };
  }

  function layout() {
    W = pin.clientWidth; VH = pin.clientHeight; Hs = frame.clientHeight; mob = W < 900;
    filmTop = film.getBoundingClientRect().top + window.scrollY;
    TL = buildTL();
    IT = ITEMS.map((_, i) => { const G = TL.groups[ITEMS[i][1]]; return { G, it: G.items.find((x) => x.i === i) }; });
    film.style.setProperty('--film-h', ((TL.end + 1) * VH) + 'px');
    const g = stageGeom(film);
    ({ k, phC, heroPh } = g);
    LB = labs.map((el) => ({ el }));
    // 大字进场那屏居中放大；之后缩向小标签的位置、淡掉，小标签接着出来
    TT = titles.map((el) => { const b = fitTitle(el); return { el, ...b, sc: Math.min(1, (g.labH * 2.2) / b.bh), tx: g.colL - b.bx, ty: g.ly - b.by }; });
    put(rigBox, 'transform', `translate3d(${phC.x.toFixed(1)}px,${phC.y.toFixed(1)}px,0)`);
    put(glow, 'transform', `translate3d(${phC.x.toFixed(1)}px,${phC.y.toFixed(1)}px,0) scale(${f3(k * 1.1)})`);
    wave = [Hs * 0.47, mob ? Hs * 0.11 : Hs * 0.16];
    ST.k = k;
    if (T) Object.assign(T, { tl: TL, filmTop, H: VH, k });
    phone.remeasure();
    outro.layout(); secPos();
    if (P) uploadParticles();
    rail.place(TL.groups.map((G) => jumpAt(G) / TL.end));
    wake();
  }

  // 粒子只取两个字形：开场大字、第 1 组标题（按没变形时的位置取）
  function uploadParticles() {
    const ref = pin.getBoundingClientRect();
    const n = Math.round(Math.min(mob ? 4000 : 11000, Math.max(3800, W * VH / 64)));
    const t0 = titles[0], tv = t0.style.transform, hv = hero.style.transform;
    t0.style.transform = 'none'; hero.style.transform = 'none';
    const targets = [sampleText(h1, n, W, VH, ref), sampleText(t0, n, W, VH, ref)];
    hero.style.transform = hv; t0.style.transform = tv;
    P.upload(targets, W, VH, n);
    SC.delete(hero); SC.delete(t0);
  }

  let curItem = -1, playing = false, posed = false;
  function render(now) {
    const t = now / 1000;
    const s = (sy - filmTop) / VH;
    const G = TL.groups;
    if (!riveAsked && s > G[0].P[0] - 0.6) askRive();
    // 开场：大字一打开就是实心字；往下滑才换成粒子散开成声波
    const hx = seg(s, 0.05, 0.18);
    const ui = sm(seg(s, 0.02, 0.28));
    put(nav, 'opacity', f3(1 - ui)); put(nav, 'transform', `translate3d(0,${(-24 * ui).toFixed(1)}px,0)`);
    put(heroFoot, 'opacity', f3(1 - ui)); put(heroFoot, 'transform', `translate3d(0,${(40 * ui).toFixed(1)}px,0)`);
    const h1o = P ? 1 - hx : 1 - sm(seg(s, 0.1, 0.4));
    put(h1, 'opacity', f3(h1o));
    put(hero, 'visibility', ui >= 1 && h1o <= 0 ? 'hidden' : 'visible');
    // 粒子（只在开场）：大字散成声波（0 → 2），声波聚成第 1 组标题（2 → 1），聚好换成实字
    let st = null;
    const G0 = G[0];
    if (s < G0.st) st = s < 0.18 ? { a: 0, b: 0, k: 0, amp: 0, alpha: sm(hx) } : { a: 0, b: 2, k: seg(s, 0.18, 0.8), amp: mob ? 60 : 110, alpha: 1 };
    else if (s < G0.X[1]) st = { a: 2, b: 1, k: seg(s, G0.A[0], G0.A[1]), amp: mob ? 90 : 160, alpha: 1 - sm(seg(s, G0.X[0], G0.X[1])) };
    if (P && P.ok && st && st.alpha > 0.002) { put(pcan, 'visibility', 'visible'); P.draw(st, t % 600, mob, wave); }
    else if (P) put(pcan, 'visibility', 'hidden');
    // 组标题（进场那屏放大）和小标签（之后一直在左上）：push 底色整页从右推进来，大字同时从右边滑一小段到位、淡入（不出屏，停在哪都是整句）；
    // wipe 底色斜着扫过的同时大字从下往上浮出来；open 大字先出来、圆角底色在它后面放大
    let phoneVis = 0, phoneIn = 0, phoneOut = 0, gi = -1, bigO = 0;
    TT.forEach((T, g) => {
      const Gg = G[g], mode = TR[g], L = LB[g];
      let o, dx = 0, dy = 0, s0 = 1;
      if (mode === 'push') { o = sm(seg(s, Gg.st, Gg.st + 0.3)); dx = (1 - eio(seg(s, Gg.st, Gg.A[1]))) * Math.max(0, Math.min(W * 0.12, (W - T.bw) / 2 - 4)); }
      else if (mode === 'wipe') { o = sm(seg(s, Gg.st + 0.05, Gg.st + 0.35)); dy = (1 - eo(seg(s, Gg.st + 0.05, Gg.A[1]))) * 0.3 * T.bh; }
      else if (mode === 'open') { o = sm(seg(s, Gg.st, Gg.st + 0.2)); s0 = lerp(0.9, 1, eo(seg(s, Gg.st, Gg.st + 0.4))); }
      else if (P) o = sm(seg(s, Gg.X[0], Gg.X[1]));
      else { o = sm(seg(s, Gg.A[0] + 0.3, Gg.X[1])); s0 = lerp(1.06, 1, sm(seg(s, Gg.A[0] + 0.3, Gg.X[1]))); }
      const kk = eio(seg(s, Gg.K[0], Gg.K[1]));
      const to = o * (1 - sm(seg(kk, 0.3, 0.8)));
      let lo = sm(seg(kk, 0.5, 1));
      // 小标签跟手机、最后一句一起退（接力：下一组的大字进来时才退）
      lo *= 1 - sm(seg(s, Gg.out[0], Gg.out[1]));
      const sc = lerp(s0, T.sc, kk);
      put(T.el, 'opacity', f3(to));
      if (to > bigO) bigO = to;
      put(T.el, 'visibility', to > 0.002 ? 'visible' : 'hidden');
      if (to > 0.002) put(T.el, 'transform', `translate3d(${(T.tx * kk + dx).toFixed(1)}px,${(T.ty * kk + dy).toFixed(1)}px,0) scale(${sc.toFixed(4)})`);
      put(L.el, 'opacity', f3(lo));
      put(L.el, 'visibility', lo > 0.002 ? 'visible' : 'hidden');
      if (s >= Gg.P[0] && s < Gg.out[1]) { gi = g; phoneIn = eOut(seg(s, Gg.P[0], Gg.P[1])); phoneOut = eio(seg(s, Gg.out[0], Gg.out[1])); }
    });
    // 手机：首屏从底下露出上沿，往下滑跟着首屏的字往下退；每组侧着转进来 → 转正，本组结束往下退
    let rigO = 0;
    if (gi >= 0) {
      phoneVis = phoneIn * (1 - phoneOut);
      const ry = -12 * (1 - phoneIn), rx = 8 * (1 - phoneIn), y = (1 - phoneIn) * VH * 0.25 + phoneOut * VH * 0.35;
      const sc = k * lerp(0.78, 1, phoneIn) * (1 - 0.08 * phoneOut);
      // 透视只在转动时加：缩放加透视会把手机先按原大画好再按 3D 缩小，电脑上字发虚；不转时去掉，转正那一刻画面不变
      const turn = phoneIn < 1;
      put(rig, 'transform', `${turn ? 'perspective(1700px) ' : ''}translate3d(0,${y.toFixed(1)}px,0) scale(${sc.toFixed(4)})${turn ? ` rotateY(${ry.toFixed(2)}deg) rotateX(${rx.toFixed(2)}deg)` : ''}`);
      rigO = Math.min(sm(phoneVis), 1 - bigO);
    } else if (ui < 1) {
      rigO = 1 - ui;
      put(rig, 'transform', `translate3d(${heroPh.dx.toFixed(1)}px,${(heroPh.dy + ui * VH * 0.3).toFixed(1)}px,0) scale(${k.toFixed(4)})`);
    }
    put(rig, 'opacity', f3(rigO));
    put(rigBox, 'visibility', rigO > 0.002 ? 'visible' : 'hidden');
    put(glow, 'opacity', f3(0.9 * phoneVis));
    const ent = gi >= 0 && phoneIn < 1;
    if (ent !== rig.classList.contains('ent')) rig.classList.toggle('ent', ent);
    // 每一项：说明文字一句句换；演示时间 = max(时钟, 滚动推到的时间)，前 70% 的滚动推到出结果那一刻
    let active = -1, push = 0;
    caps.forEach((c, i) => {
      const { G: Gg, it } = IT[i];
      const first = it.a === Gg.i0, last = it.b >= Gg.end - 0.001;
      const fin = first ? sm(seg(s, Gg.P[0] + 0.2, Gg.i0 + 0.05)) : sm(seg(s, it.a - 0.08, it.a + 0.14));
      const fout = last ? sm(seg(s, Gg.out[0], Gg.out[1] - 0.05)) : sm(seg(s, it.b - 0.14, it.b + 0.04));
      const op = fin * (1 - fout);
      put(c, 'opacity', f3(op));
      put(c, 'visibility', op > 0.002 ? 'visible' : 'hidden');
      put(c, 'transform', `translate3d(0,${((1 - fin) * 26 - fout * 26).toFixed(1)}px,0)`);
      if (s >= (first ? Gg.P[0] : it.a - 0.06) && s < (last ? Gg.out[1] : it.b - 0.06)) {
        active = i;
        push = Math.min(1, clamp((s - it.a) / (it.b - it.a)) / 0.7) * (DEMO[it.name].res || 0);
      }
    });
    if (active >= 0) {
      posed = false;
      if (active !== curItem) { phone.show(ITEMS[active][0], now); curItem = active; }
      if (phoneVis > 0.05) phone.run(now, push); else phone.stop();
    } else if (rigO > 0.002 && !posed) { phone.pose('type', now); curItem = -1; posed = true; }
    playing = active >= 0 && phoneVis > 0.05;
    // 吉祥物真播：只在演示播着时播；当前这一屏没有的那块整个收掉
    const pc = phone.cur, scr = pc ? phone.screen(pc) : null, on = playing;
    if (liveN) { const h = scr && $('.nc .ms', scr); if (h && on) { liveN.move(h); liveN.ask('15'); } liveN.run(on && !!h); }
    if (liveK) {
      const h = scr && $('.pk-rv', scr);
      if (h && on) { liveK.move(h); liveK.ask('peek'); }
      liveK.run(on && !!h);
      if (h && on) {
        // 正在打字：打字条里的字正在一个个出来（--p 在 0 和 1 之间）
        const typing = $$('.ty', scr).some((q) => { const v = +q.style.getPropertyValue('--p'); return v > 0 && v < 1; });
        if (typing) pkIdle = now + 1000;
        liveK.setBool('writingSent', typing || now < pkIdle);
      }
    }
    if (liveP) {
      // 第九轮：只建最后那只（轮换里停得最久，约 3.6 秒），第 0～5 只一直是静帧。
      // 停在隐私记、300ms 没滚动又空闲时先建；没在隐私记停过的，等吉祥物这一项演示播到最后一次点击、画面定住（约 2.6 秒）以后，再等 300ms 没滚动、空闲时建
      if (active === MASC_I - 2 || (active === MASC_I && pc === 'masc' && phone.e >= 2.6)) liveP.want(MASCOT_IDS[MASCOT_IDS.length - 1]);
      else liveP.stop();   // 离开了：还没建的不建了
      if (pc === 'masc') { const m = /(?:^| )q([1-6])(?: |$)/.exec(scr.className); liveP.show(MASCOT_IDS[m ? +m[1] : 0], on); } else liveP.pause();
    }
    // 第 2～4 组的底色层（只动 transform、opacity）：2 整页从右推进来；3 斜着一整块从左扫过去；4 圆角画面从中间放大铺满。铺满以后留作这一组的底，被下一层盖满就藏起来
    let bgI = 0;
    for (let g = 1; g < 4; g++) {
      const el = LAY[g], Gg = G[g], Gn = G[g + 1];
      if (s >= Gg.st + 0.25) bgI = g;
      if (s < Gg.st - 0.02 || (Gn && s >= Gn.A[1] + 0.05)) { put(el, 'visibility', 'hidden'); continue; }
      put(el, 'visibility', 'visible');
      if (TR[g] === 'push') put(el, 'transform', `translate3d(${f3((1 - eio(seg(s, Gg.st, Gg.A[1]))) * 100)}%,0,0)`);
      else if (TR[g] === 'wipe') put(el, 'transform', `translate3d(${f3((eio(seg(s, Gg.st, Gg.A[1])) - 1) * 100)}%,0,0) skewX(-14deg)`);
      else {
        put(el, 'opacity', f3(sm(seg(s, Gg.st + 0.05, Gg.st + 0.15))));
        put(el, 'transform', `scale(${f3(lerp(0.4, 1.06, eio(seg(s, Gg.st + 0.05, Gg.A[1]))))})`);
      }
    }
    if (pin.dataset.bg !== String(bgI)) pin.dataset.bg = String(bgI);
    // 收尾大字
    outro.render(sy);
    // 右下角“看演示”：首屏滚出去以后一直在，到收尾卡片出来时让开；右侧进度条只在四组那一段
    dock.classList.toggle('on', s > 0.3 && sy < outro.top - VH * 0.2);
    dock.classList.toggle('sm', sy + VH > secY[0] && sy < secY[1]);
    let gc = 0;
    for (let g = 0; g < 4; g++) if (s >= G[g].st) gc = g;
    rail.set(s > 0.3 && s < TL.end + 0.3, s / TL.end, gc, bigO > 0.1);
    if (T) { T.s = +s.toFixed(3); T.item = active; T.cur = phone.cur; T.e = +phone.e.toFixed(2); }
  }

  // 11-26 第五轮：直接用真实滚动位置（去掉 65ms 的跟随平滑）；滚动停了 300 毫秒、又没有演示在播（或整段不在屏幕上）就停主循环，一滚动再续
  let sy = window.scrollY, raf = 0, lastScroll = -1e9, filmOn = true;
  function tick(now) {
    raf = 0;
    sy = window.scrollY;
    render(now);
    if (now - lastScroll < 300 || (playing && filmOn)) raf = requestAnimationFrame(tick);
  }
  function wake() { lastScroll = performance.now(); if (!raf) raf = requestAnimationFrame(tick); }
  window.addEventListener('scroll', wake, { passive: true });
  if ('IntersectionObserver' in window) new IntersectionObserver((es) => { filmOn = es[es.length - 1].isIntersecting; if (filmOn) wake(); }).observe(film);
  let rw = 0, rh = 0, rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (pin.clientWidth === rw && pin.clientHeight === rh) return; rw = pin.clientWidth; rh = pin.clientHeight; layout(); }, 140);
  });
  $$('.qa details').forEach((d) => d.addEventListener('toggle', () => { outro.layout(); secPos(); wake(); }));

  ST.relay = () => { outro.layout(); secPos(); wake(); };
  if (T) Object.assign(T, { mode: 'fx', gl: false, s: 0, item: -1, e: 0, wake });
  layout();
  rw = pin.clientWidth; rh = pin.clientHeight;
  // 首屏画完再起 WebGL（拿不到就用文字淡入）
  requestAnimationFrame(() => setTimeout(() => {
    try { P = makeParticles(pcan); if (P) { uploadParticles(); if (T) T.gl = true; } } catch { P = null; }
    wake();
  }, 60));
}

export { initFx, stageGeom };
