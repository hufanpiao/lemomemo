// 告知页的四个回调：只在真要显示告知页时才用得到，跟着 ui/ConsentRoute.tsx 那一块懒加载
// 已经同意过的人冷启动只过关口（ui/ConsentGate.tsx + hooks/useConsentWiring.ts），不下载这里带进来的离开设备、账号状态、多标签页通知、写 AI 开关
// 不变量：onRevoked、onDisabled 经 data/consent-exit.ts 交 core/device-exit.ts（被移除先查 session_fate 才清库）；同意后写 ai.enabled 写不进不挡进 App
import { useCallback } from 'react';
import { writeAiSwitchSettled } from '../../../core/ai-settings.ts';
import { readSessionId } from '../../../platform/session.ts';
import { setConsentStale } from '../../../kit/state/consent-fresh.ts';
import { leaveThisDevice } from '../data/consent-exit.ts';
import type { ConsentHandlers } from './useConsent.ts';

export interface ConsentWiringDeps {
  enableAi(): Promise<unknown>;
  /** sid：被拒那次请求用的会话，离开时只删它。false = 探测说账号正常、没离开（data/consent-exit.ts） */
  leave(code: 'session_revoked' | 'account_disabled', sid: string | null): Promise<boolean | void>;
}

export const defaultConsentWiringDeps: ConsentWiringDeps = {
  enableAi: () => writeAiSwitchSettled({ key: 'ai.enabled', value: true }),
  leave: (code, sid) => leaveThisDevice(code, sid),
};

/** ConsentPage 的四个回调；finish = 进 App（或回到原来的页面） */
export function useConsentHandlers(finish: () => void, deps: ConsentWiringDeps = defaultConsentWiringDeps): ConsentHandlers {
  const onDone = useCallback(
    (agreed: boolean) => {
      setConsentStale(!agreed, readSessionId()); // 服务器已记下当前版本；不同意时 ai.enabled 同步回来之前也不发
      if (agreed) void deps.enableAi().catch(() => undefined);
      finish();
    },
    [deps, finish],
  );
  const onRevoked = useCallback((sid: string | null) => void deps.leave('session_revoked', sid), [deps]);
  // 探测说账号正常：留在告知页，按设置页的口径提示一句通用错误（onStay）
  const onDisabled = useCallback(
    (sid: string | null, onStay?: () => void) =>
      void deps.leave('account_disabled', sid).then((left) => (left === false ? onStay?.() : undefined), () => undefined),
    [deps],
  );
  return { onDone, onRevoked, onDisabled, onSkip: finish };
}
