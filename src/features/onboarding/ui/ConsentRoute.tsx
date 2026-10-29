// 路由 #/onboarding：告知与同意页（接手清单 CONSENT-wire ①）。容器只接线：api 和四个回调来自 hooks/useConsentWiring.ts（A27：ui 不引 data）
// 做完（同意、不同意、R-239 跳过）回今天页
import { useCallback } from 'react';
import { navigate } from '../../../app/router.ts';
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
  const finish = useCallback(() => void navigate('today'), []);
  const handlers = useConsentHandlers(finish, wiring);
  return <ConsentPage api={api} {...handlers} />;
}
