// 路由 #/onboarding：告知与同意页（接手清单 CONSENT-wire ①）。容器只接线：api 和四个回调来自 hooks/useConsentWiring.ts（A27：ui 不引 data）
// 做完（同意、不同意、R-239 跳过）回今天页；从 设置 › 语音与 AI 打开“AI 整理”进来的（#/onboarding/ai，R-369）回那一页（退一步，不多压历史）
import { useCallback } from 'react';
import { backOrReplace, navigate, useRoute } from '../../../app/router.ts';
import type { ConsentApi } from '../hooks/useConsent.ts';
import { defaultConsentWiringDeps, useConsentApi, useConsentHandlers, type ConsentWiringDeps } from '../hooks/useConsentWiring.ts';
import ConsentPage from './ConsentPage.tsx';

export interface ConsentRouteProps {
  /** 测试用：换掉接口和回调里的写 ai.enabled、离开设备 */
  api?: ConsentApi;
  wiring?: ConsentWiringDeps;
}

export default function ConsentRoute({ api: injected, wiring = defaultConsentWiringDeps }: ConsentRouteProps) {
  const shared = useConsentApi();
  const api = injected ?? shared;
  const fromAi = useRoute().params[0] === 'ai';
  const finish = useCallback(() => (fromAi ? backOrReplace('settings', 'ai') : void navigate('today')), [fromAi]);
  const handlers = useConsentHandlers(finish, wiring);
  return <ConsentPage api={api} {...handlers} />;
}
