// 页面在用期间占住升级中心的 busy（BUSY-wire，B2 FA-5；接手清单第 184 行）：
// 编辑页挂着时不出“有新版本”这类横幅、不自动重新载入，离开（卸载）就释放（录音不用这个：跟着控制器的状态占，features/plus/data/voice-session.ts）。
// 还没启动（测试里、启动前）拿不到升级中心就什么都不做。令牌 30 分钟作废的规则在 core/upgrade.ts
// on：给 false 时不占（电脑详情抽屉只在焦点在抽屉里时占，kit DetailDrawer；B6 独立评审第 12 条），由真变假就释放
import { useEffect } from 'react';
import { getBoot } from '../../core/boot.ts';
import type { BusyReason } from '../../core/upgrade.ts';

export function useHoldBusy(reason: BusyReason, on = true): void {
  useEffect(() => {
    if (!on) return;
    const upgrade = getBoot()?.upgrade;
    if (!upgrade) return;
    return upgrade.holdBusy(reason);
  }, [reason, on]);
}
