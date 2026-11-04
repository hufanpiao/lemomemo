// 页面在用期间占住升级中心的 busy（BUSY-wire，B2 FA-5；接手清单第 184 行）：
// 编辑页、录音面板挂着时不出“有新版本”这类横幅、不自动重新载入，离开（卸载）就释放。
// 还没启动（测试里、启动前）拿不到升级中心就什么都不做。令牌 30 分钟作废的规则在 core/upgrade.ts
import { useEffect } from 'react';
import { getBoot } from '../../core/boot.ts';
import type { BusyReason } from '../../core/upgrade.ts';

export function useHoldBusy(reason: BusyReason, active = true): void {
  useEffect(() => {
    if (!active) return;
    const upgrade = getBoot()?.upgrade;
    if (!upgrade) return;
    return upgrade.holdBusy(reason);
  }, [reason, active]);
}
