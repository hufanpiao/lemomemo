// 液态玻璃的玻璃标记（data-glass）、帧循环（B2 FA-7；架构 0.27 第 5 点 R-153；试验页 皮肤-v4/液态玻璃-真机试验.html 第 2 版）
// 底栏外壳（kit/components/GlassBar）首屏画完后按需下载这个文件；没下载到时外壳用 backdrop-filter 后备，样子接近
// • 11-06 起不再复制页面内容（GLASS-copy-unused，主持人 11-06 同意改 motion）：模糊改由底栏 .bar、“＋” .fab 自己的 backdrop-filter 做，
//   引擎只给玻璃块写 data-glass="copy"（样式换成 --g-live-fx 那一档）
// • 自动深浅（data-ad="dark"）11-06 取消（主持人 11-06 定方案甲，motion 改动已同意）：负责人要求底栏后面一律是实色 --bg
//   （GlassBarFx.module.css .band），背后不会再有深色内容，判断深浅没有意义；原来按 DOM 面积算，盖在实色下面的深色卡片也会让底栏变深，反而出错
// • 帧循环：只在 poke（液滴在动、按下底栏）和“减少透明效果”开关变了时跑一次，停下 IDLE_MS 后停掉；rAF 只在 motion 里（A25）
// • 减少透明效果（:root[data-rt="1"]，platform/look.ts 按设置里的开关或系统设置写）：不写 data-glass，外壳用实色
// • 倾斜高光已删除（R-373，负责人 11-10“设置里面倾斜高光去掉，不要这个功能了”）：高光固定在原来关着时的位置（GlassBar.module.css）；
//   以前存过的本机开关 lemo.tilt 由 forgetTilt 删掉：GlassBarFx 下载完这个文件就调，不分宽窄屏（宽屏不开引擎也要删）；读不到、删不掉（隐私模式）都不管
import { prefersReducedMotion } from './reduced.ts';

export type GhostFx = 'copy' | 'drop';
export interface GlassPiece {
  /** 那块玻璃本身（底栏 nav、“＋”按钮、液滴）：引擎在它身上写 data-glass（copy 是底栏和“＋”，drop 是液滴；11-06 起不再建副本、也没有副本滤镜档了） */
  el: HTMLElement;
  fx: GhostFx;
}
export interface GlassOptions {
  pieces: readonly GlassPiece[];
}

export const IDLE_MS = 100;

/** 减少透明效果：只看 data-rt（platform/look.ts 按设置里的开关或系统设置写） */
export function reducedTransparency(): boolean {
  return document.documentElement.dataset['rt'] === '1';
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

/** 开始：返回停止函数（卸载底栏时调）；poke 让帧循环跑一会儿（液滴在动时调） */
/** 删掉倾斜高光（R-373 已删除）以前存的本机开关；读写不了（隐私模式）不管 */
export function forgetTilt(): void {
  try {
    localStorage.removeItem('lemo.tilt');
  } catch {
    // 隐私模式读写不了：不管
  }
}

export function startGlass(opts: GlassOptions): { stop(): void; poke(ms?: number): void } {
  let raf = 0;
  let until = 0;
  let stopped = false;
  let on = false;

  const setOn = (v: boolean): void => {
    if (on === v) return;
    on = v;
    for (const p of opts.pieces) {
      if (v) p.el.setAttribute('data-glass', 'copy');
      else p.el.removeAttribute('data-glass');
    }
  };

  const frame = (now: number): void => {
    raf = 0;
    if (stopped) return;
    setOn(!reducedTransparency());
    if (on && now < until) raf = requestAnimationFrame(frame);
  };

  const poke = (ms = IDLE_MS): void => {
    if (stopped) return;
    until = Math.max(until, performance.now() + ms);
    if (raf === 0) raf = requestAnimationFrame(frame);
  };

  // “减少透明效果”变了（data-rt 改写）：跑一次，开关 data-glass
  const onRt = (): void => poke();
  const mo = new MutationObserver(onRt);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-rt'] });
  poke(300);

  return {
    poke,
    stop(): void {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      mo.disconnect();
      setOn(false);
    },
  };
}
