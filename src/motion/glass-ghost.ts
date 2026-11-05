// 液态玻璃的内容副本、自动深浅、帧循环（B2 FA-7；架构 0.27 第 5 点 R-153；试验页 皮肤-v4/液态玻璃-真机试验.html 第 2 版）
// 底栏外壳（kit/components/GlassBar）首屏画完后按需下载这个文件；没下载到时外壳用 backdrop-filter 后备，样子接近
// • 副本：页面里带 data-ghost 的元素进到屏幕底部 BAND 那一段时进候选（IntersectionObserver）；帧循环里把和某块玻璃相交的候选
//   cloneNode 一份放进那块玻璃最底下的一层（绝对定位、按位置平移，滤镜 --g-copy-fx / 液滴 --g-drop-fx），玻璃着色叠在上面
//   副本不进读屏、不能聚焦：整层 aria-hidden + inert；输入框 disabled、链接去 href、去掉 id 和 data-testid；隐私记（data-private、
//   隐私记页）不建副本
// • 自动深浅：底栏背后深色内容占的面积 > 55% 时底栏 data-ad="dark"，< 45% 换回（中间不动，防抖）；颜色在 GlassBar.module.css
// • 帧循环：只在滚动、改尺寸、页面内容变了、液滴在动（poke）时跑，停下 IDLE_MS 后停掉；rAF 只在 motion 里（A25）
// • 减少透明效果（系统设置或 :root[data-rt="1"]）：不建副本、清掉已有的，外壳用实色
// • 倾斜高光（TILT-b2，设置里开了才有）：跟着引擎一起开停，写法在 glass-tilt.ts；高光变量写在底栏和“＋”上（液滴在底栏里，继承）
import { startTilt } from './glass-tilt.ts';
import { prefersReducedMotion } from './reduced.ts';

export type GhostFx = 'copy' | 'drop';
export interface GlassPiece {
  /** 那块玻璃本身（底栏 nav、“＋”按钮、液滴）：副本层放进它最前面，圆角跟它 */
  el: HTMLElement;
  fx: GhostFx;
}
export interface GlassOptions {
  pieces: readonly GlassPiece[];
  /** 自动深浅写在它身上（底栏 nav） */
  adTarget: HTMLElement;
}

/** 候选只看屏幕最下面这一段（底栏、“＋”、液滴都在里面） */
export const BAND = 200;
export const IDLE_MS = 100;
export const AD_ON = 0.55;
export const AD_OFF = 0.45;

const LAYER = 'data-glass-layer';

/** 减少透明效果：系统设置或页面开关 */
export function reducedTransparency(): boolean {
  if (document.documentElement.dataset['rt'] === '1') return true;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-transparency: reduce)').matches;
}

/** 颜色字符串（rgb()/rgba()）的亮度 0～1；透明的返回 null */
export function luminance(color: string): number | null {
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?/.exec(color);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
  if (a < 0.5) return null;
  const lin = (v: string): number => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(m[1] ?? '0') + 0.7152 * lin(m[2] ?? '0') + 0.0722 * lin(m[3] ?? '0');
}

/** 一个候选算不算深色：背景色（没有就看背景渐变里第一个颜色）亮度 < 0.18 */
export function isDarkEl(el: Element): boolean {
  const cs = getComputedStyle(el);
  const l = luminance(cs.backgroundColor) ?? luminance(/rgba?\([^)]*\)/.exec(cs.backgroundImage)?.[0] ?? '');
  return l !== null && l < 0.18;
}

/** 深色占比 → 下一个状态（滞回：中间段保持原样） */
export function nextAd(ratio: number, dark: boolean): boolean {
  if (ratio > AD_ON) return true;
  if (ratio < AD_OFF) return false;
  return dark;
}

/** 副本：去掉能被读屏、聚焦、点到、被测试按 testid 找到的东西；去掉 name、form（代码复查 L5：同名单选框的副本会和原件算成一组，
 *  副本放进文档时把原件的选中挤掉；form 属性会让副本归到原来的表单里） */
export function makeCopy(src: HTMLElement): HTMLElement {
  const c = src.cloneNode(true) as HTMLElement;
  for (const n of [c, ...c.querySelectorAll<HTMLElement>('*')]) {
    n.removeAttribute('id');
    n.removeAttribute('name');
    n.removeAttribute('form');
    n.removeAttribute('data-testid');
    n.removeAttribute('data-ghost');
    n.removeAttribute('tabindex');
    if (n instanceof HTMLAnchorElement) n.removeAttribute('href');
    if (n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement || n instanceof HTMLSelectElement || n instanceof HTMLButtonElement) n.disabled = true;
  }
  const cs = getComputedStyle(src);
  const st = c.style;
  st.setProperty('position', 'absolute');
  st.setProperty('left', '0');
  st.setProperty('top', '0');
  st.setProperty('margin', '0');
  st.setProperty('width', `${src.offsetWidth}px`);
  // 继承来的字色、字体：副本脱离了原来的父元素，照抄算好的值
  st.setProperty('color', cs.color);
  st.setProperty('font', cs.font);
  st.setProperty('pointer-events', 'none');
  return c;
}

/** CSS 时长（".55s"、"550ms"）→ 毫秒 */
const msOf = (v: string): number => (v.trim().endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000);

/**
 * 液滴“果冻”（设计动效评审 L1）：连点时从当前形变接着放，不跳回原样再从头放。关键帧、时长、曲线和 GlassBarFx.module.css 的 @keyframes gel 一样
 * （--dur-drop、--ease-gel，负责人 11-05 定 D4 维持现状）。返回 false：没有 WAAPI，调用方退回 CSS 动画（换 key 重挂）
 */
export function playGel(el: HTMLElement): boolean {
  if (typeof el.animate !== 'function') return false;
  const cs = getComputedStyle(el);
  const from = cs.scale && cs.scale !== 'none' ? cs.scale : '1';
  for (const a of el.getAnimations()) a.cancel();
  if (prefersReducedMotion()) return true;
  const easing = cs.getPropertyValue('--ease-gel').trim() || 'ease';
  el.animate(
    [
      { scale: from, easing },
      { scale: '1.22 0.86', offset: 0.35, easing },
      { scale: '0.96 1.04', offset: 0.7, easing },
      { scale: '1' },
    ],
    { duration: msOf(cs.getPropertyValue('--dur-drop')) || 550 },
  );
  return true;
}

const privateEl = (el: Element): boolean => el.closest('[data-private],[data-feature="vault"]') !== null;

interface Layer {
  piece: GlassPiece;
  box: HTMLElement;
  copies: Map<HTMLElement, HTMLElement>;
}

function makeLayer(piece: GlassPiece): Layer {
  const box = document.createElement('div');
  box.setAttribute(LAYER, piece.fx);
  box.setAttribute('aria-hidden', 'true');
  box.inert = true;
  const st = box.style;
  st.setProperty('position', 'absolute');
  st.setProperty('inset', '0');
  st.setProperty('overflow', 'hidden');
  st.setProperty('border-radius', 'inherit');
  st.setProperty('pointer-events', 'none');
  st.setProperty('background', 'var(--bg)');
  st.setProperty('filter', piece.fx === 'drop' ? 'var(--g-drop-fx)' : 'var(--g-copy-fx)');
  piece.el.prepend(box);
  return { piece, box, copies: new Map() };
}

const overlap = (a: DOMRect, b: DOMRect): number =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/** 开始：返回停止函数（卸载底栏时调）；poke 让帧循环跑一会儿（液滴在动时调） */
export function startGlass(opts: GlassOptions): { stop(): void; poke(ms?: number): void } {
  const layers: Layer[] = [];
  const candidates = new Set<HTMLElement>();
  const darkOf = new WeakMap<HTMLElement, boolean>();
  let dark = false;
  let raf = 0;
  let until = 0;
  let stopped = false;
  let on = false;

  const clearCopies = (): void => {
    for (const l of layers) {
      for (const c of l.copies.values()) c.remove();
      l.copies.clear();
    }
  };
  const setOn = (v: boolean): void => {
    if (on === v) return;
    on = v;
    for (const p of opts.pieces) {
      if (v) p.el.setAttribute('data-glass', 'copy');
      else p.el.removeAttribute('data-glass');
    }
    if (v) {
      if (layers.length === 0) for (const p of opts.pieces) layers.push(makeLayer(p));
    } else {
      for (const l of layers) l.box.remove();
      layers.length = 0;
      opts.adTarget.removeAttribute('data-ad');
      dark = false;
    }
  };

  const frame = (now: number): void => {
    raf = 0;
    if (stopped) return;
    if (reducedTransparency()) {
      setOn(false);
      return;
    }
    setOn(true);
    let darkArea = 0;
    let adArea = 0;
    const adRect = opts.adTarget.getBoundingClientRect();
    adArea = adRect.width * adRect.height;
    const rects = new Map<HTMLElement, DOMRect>();
    for (const c of candidates) {
      if (!c.isConnected) {
        candidates.delete(c);
        continue;
      }
      rects.set(c, c.getBoundingClientRect());
    }
    for (const l of layers) {
      const pr = l.piece.el.getBoundingClientRect();
      const sx = l.piece.el.offsetWidth ? pr.width / l.piece.el.offsetWidth : 1;
      const sy = l.piece.el.offsetHeight ? pr.height / l.piece.el.offsetHeight : 1;
      for (const [c, r] of rects) {
        if (overlap(pr, r) === 0) {
          l.copies.get(c)?.remove();
          l.copies.delete(c);
          continue;
        }
        let copy = l.copies.get(c);
        if (!copy) {
          copy = makeCopy(c);
          l.copies.set(c, copy);
          l.box.append(copy);
        }
        copy.style.setProperty('transform', `translate(${(r.left - pr.left) / sx}px, ${(r.top - pr.top) / sy}px)`);
      }
      for (const [c, copy] of l.copies) {
        if (!rects.has(c)) {
          copy.remove();
          l.copies.delete(c);
        }
      }
    }
    for (const [c, r] of rects) {
      let d = darkOf.get(c);
      if (d === undefined) {
        d = isDarkEl(c);
        darkOf.set(c, d);
      }
      if (d) darkArea += overlap(adRect, r);
    }
    const next = nextAd(adArea > 0 ? darkArea / adArea : 0, dark);
    if (next !== dark) {
      dark = next;
      if (dark) opts.adTarget.setAttribute('data-ad', 'dark');
      else opts.adTarget.removeAttribute('data-ad');
    }
    if (now < until) raf = requestAnimationFrame(frame);
  };

  const poke = (ms = IDLE_MS): void => {
    if (stopped) return;
    until = Math.max(until, performance.now() + ms);
    if (raf === 0) raf = requestAnimationFrame(frame);
  };

  // 候选：屏幕最底下 BAND 那一段里的 data-ghost
  let io: IntersectionObserver | null = null;
  const watch = (): void => {
    io?.disconnect();
    candidates.clear();
    io = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          const el = e.target as HTMLElement;
          if (e.isIntersecting && !privateEl(el)) candidates.add(el);
          else candidates.delete(el);
        }
        poke();
      },
      { rootMargin: `-${Math.max(0, innerHeight - BAND)}px 0px 0px 0px` },
    );
    for (const el of document.querySelectorAll<HTMLElement>('main [data-ghost]')) io.observe(el);
  };
  watch();

  // 页面内容变了：重新找候选、副本重做（文字改了、行增删）
  const mo = new MutationObserver((ms) => {
    // 玻璃块自己（底栏、“＋”、液滴，带 data-glass）里的变化：副本层插进去、液滴重挂，都不算页面变了
    if (ms.every((m) => (m.target as Element).closest?.(`[${LAYER}],[data-glass]`))) return;
    for (const el of document.querySelectorAll<HTMLElement>('main [data-ghost]')) io?.observe(el);
    clearCopies();
    poke();
  });
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });

  const onScroll = (): void => poke();
  const onResize = (): void => {
    watch();
    poke();
  };
  addEventListener('scroll', onScroll, { capture: true, passive: true });
  addEventListener('resize', onResize);
  poke(300);
  const flat = opts.pieces.filter((p) => p.fx === 'copy').map((p) => p.el);
  const tilt = startTilt(flat, flat);

  return {
    poke,
    stop(): void {
      stopped = true;
      tilt.stop();
      if (raf) cancelAnimationFrame(raf);
      io?.disconnect();
      mo.disconnect();
      removeEventListener('scroll', onScroll, { capture: true });
      removeEventListener('resize', onResize);
      setOn(false);
    },
  };
}
