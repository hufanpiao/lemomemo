// 顶部版本横幅该出哪一条（纯函数，从 UpdateBanner.tsx 挪出，11-05 首屏瘦身，主持人定第 4 项）：
// App.tsx 的横幅关口在首屏里用它判断“现在有没有要出的横幅”，有了才下载 UpdateBanner.tsx（约 1 KB gzip）；UpdateBanner.tsx 原样再导出
import type { UpgradeState } from '../core/upgrade.ts';

export type BannerKind = 'required' | 'closed' | 'sync_paused' | 'new_version' | null;

/** 现在该出哪一条（纯函数，单测用）；syncPaused：ui-store 里有 sync-paused 横幅 */
export function bannerKind(s: UpgradeState, syncPaused = false): BannerKind {
  if (s.cache === 'too_new') return null;   // 整屏提示管
  if (s.syncBlocked) return s.busy ? null : 'required';
  if (s.cache === 'closed_for_upgrade') return 'closed';
  // 录音、编辑在进行时先不出（同 new_version；第六轮审查建议 ④），busy 归零后状态一变就出
  if (syncPaused) return s.busy ? null : 'sync_paused';
  if (s.swReady && !s.swDismissed) return s.busy ? null : 'new_version';
  return null;
}
