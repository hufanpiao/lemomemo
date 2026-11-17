// 告知与同意页的容器（接手清单 CONSENT-wire ①②）：只接线，api 来自 hooks/useConsentWiring.ts，四个回调来自 hooks/useConsentHandlers.ts（A27：ui 不引 data）
// 两处共用这一个容器、同一个懒加载块：路由 #/onboarding（不给 onFinish），启动关口 ui/ConsentGate.tsx（给 variant、onFinish）。
// 回调那一套（离开设备、写 ai.enabled）只跟着这一块下载，已经同意过的人冷启动不下载（首屏瘦身 C，11-17）
// 路由进来做完（同意、不同意、R-239 跳过）回今天页；从 设置 › 语音与 AI 打开“AI 整理”进来的（#/onboarding/ai，R-369）回那一页（退一步，不多压历史）
import { useCallback } from 'react';
import { replaceRoute, useRoute } from '../../../app/router.ts';
import { backOrReplace } from '../../../app/router-sub.ts';
import type { ConsentApi } from '../hooks/useConsent.ts';
import { defaultConsentWiringDeps, useConsentHandlers, type ConsentWiringDeps } from '../hooks/useConsentHandlers.ts';
import { useConsentApi } from '../hooks/useConsentWiring.ts';
import ConsentPage from './ConsentPage.tsx';

export interface ConsentRouteProps {
  /** 测试用：换掉接口和回调里的写 ai.enabled、离开设备 */
  api?: ConsentApi;
  wiring?: ConsentWiringDeps;
  /** 启动关口用：首次告知页还是“隐私说明更新了”（默认 first） */
  variant?: 'first' | 'updated';
  /** 启动关口用：做完以后怎么办；不给就按路由的规矩回今天页或设置 */
  onFinish?: () => void;
}

export default function ConsentRoute({ api: injected, wiring = defaultConsentWiringDeps, variant, onFinish }: ConsentRouteProps) {
  const shared = useConsentApi();
  const api = injected ?? shared;
  const fromAi = useRoute().params[0] === 'ai';
  // 做完原地换成今天（R-372）：左滑不回到告知页
  const routeFinish = useCallback(() => (fromAi ? backOrReplace('settings', 'ai') : void replaceRoute('today')), [fromAi]);
  const handlers = useConsentHandlers(onFinish ?? routeFinish, wiring);
  return <ConsentPage api={api} {...(variant ? { variant } : {})} {...handlers} />;
}
