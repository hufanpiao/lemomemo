// B2-UI-b W6 验收 ④（首屏瘦身安全审 S1）：“更新”的退路（platform/sw-register.ts 的 updateServiceWorkerLazy）只返回结果、不自己重新载入，
// 什么时候载入由调用方（core/upgrade.ts 的升级中心）定：编辑中、录音中按“更新”、退路回 reloading，也要等忙完才载入，只载入一次。
// 放在 app 层：platform 的测试不准引 core（eslint boundaries）
import { describe, expect, it, vi } from 'vitest';
import { createUpgradeCenter, type BusyReason } from '../../core/upgrade.ts';
import { updateServiceWorkerLazy } from '../../platform/sw-register.ts';

describe('“更新”退路不绕过调用方的忙碌检查（W6 ④）', () => {
  for (const reason of ['editing', 'recording'] as const satisfies readonly BusyReason[]) {
    it(`${reason} 时：两次下载都失败、退路发了 SKIP_WAITING、新 SW 接管后回 reloading，不重新载入；忙完才载入一次`, async () => {
      const reload = vi.fn();
      const skip = vi.fn(async () => 'reloading' as const); // 原地址、换地址两次下载都失败（第一个参数回 null）以后的最后退路：等到新 SW 接管后回 reloading
      const u = createUpgradeCenter({
        appVersion: '4.0.0',
        reload,
        swUpdate: () => updateServiceWorkerLazy(async () => null, skip),
        attempt: { get: () => null, set: () => undefined },
        log: vi.fn(),
      });
      const release = u.holdBusy(reason);
      await u.requestUpdate();
      expect(skip).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
      release();
      expect(reload).toHaveBeenCalledTimes(1);
    });
  }
});
