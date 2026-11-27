// 液态玻璃的玻璃标记（data-glass）和液滴果冻（B2 FA-7；架构 0.27 第 5 点 R-153；试验页 皮肤-v4/液态玻璃-真机试验.html 第 2 版）
// 底栏外壳（kit/components/GlassBar）首屏画完后按需下载这个文件；没下载到时外壳用 backdrop-filter 后备，样子接近
// • 11-06 起不再复制页面内容（GLASS-copy-unused，主持人 11-06 同意改 motion）：模糊改由底栏 .bar、“＋” .fab 自己的 backdrop-filter 做，
//   这里只给玻璃块写 data-glass="copy"（样式换成 --g-live-fx 那一档）
// • 自动深浅（data-ad="dark"）11-06 取消（主持人 11-06 定方案甲，motion 改动已同意）：负责人要求底栏后面一律是实色 --bg
//   （GlassBarFx.module.css .band），背后不会再有深色内容，判断深浅没有意义；原来按 DOM 面积算，盖在实色下面的深色卡片也会让底栏变深，反而出错
// • 11-20 删掉帧循环（全 app 改善报告第四节）：副本、自动深浅、倾斜高光删掉以后，帧循环每帧只剩“按减少透明效果打或摘 data-glass”，
//   而这件事 MutationObserver 本来就盯着，poke 叫醒它多少帧都改变不了结果（启动 18 帧、按一下底栏 24 帧、换一次页签 42 帧白跑）。
//   现在 markGlass 下载到时打一次，data-rt、data-solid 变了再改一次；液滴不再打（CSS 里只有 .bar、.fab 认 data-glass）
// • 减少透明效果（:root[data-rt="1"]，系统设置）或隐私记页强制实色（:root[data-solid="1"]），都由 platform/look.ts 写：不写 data-glass，外壳用实色
// • 倾斜高光已删除（R-373，负责人 11-10“设置里面倾斜高光去掉，不要这个功能了”）：高光固定在原来关着时的位置（GlassBar.module.css）；
//   以前存过的本机开关 lemo.tilt 由 forgetTilt 删掉：GlassBarFx 下载完这个文件就调，不分宽窄屏（宽屏不开玻璃标记也要删）；读不到、删不掉（隐私模式）都不管
import { prefersReducedMotion } from './reduced.ts';

/** 减少透明效果：看 data-rt（系统设置）或 data-solid（隐私记页强制实色），都由 platform/look.ts 写 */
export function reducedTransparency(): boolean {
  const d = document.documentElement.dataset;
  return d['rt'] === '1' || d['solid'] === '1';
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

/** 删掉倾斜高光（R-373 已删除）以前存的本机开关；读写不了（隐私模式）不管 */
export function forgetTilt(): void {
  try {
    localStorage.removeItem('lemo.tilt');
  } catch {
    // 隐私模式读写不了：不管
  }
}

/**
 * 给玻璃块（底栏 nav、“＋”按钮）写 data-glass="copy"；减少透明效果或隐私记实色时摘掉，这两个属性变了跟着改（不用帧循环）。
 * 返回停止函数（卸载底栏时调）：不再跟着变，并摘掉标记
 */
export function markGlass(els: readonly HTMLElement[]): () => void {
  const sync = (): void => {
    const on = !reducedTransparency();
    for (const el of els) {
      if (on) el.setAttribute('data-glass', 'copy');
      else el.removeAttribute('data-glass');
    }
  };
  sync();
  const mo = new MutationObserver(sync);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-rt', 'data-solid'] });
  return () => {
    mo.disconnect();
    for (const el of els) el.removeAttribute('data-glass');
  };
}
