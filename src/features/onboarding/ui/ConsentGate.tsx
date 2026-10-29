// 启动时的告知页关口（接手清单 CONSENT-wire ②；架构 15.5、0.40 R-239）：main.tsx 在 mountFeatures 之后、渲染 App 之前、在线时套上它
// • 先问一次 noticeState()，结果回来以前什么也不画（#root 本来就是空的，和“等完再渲染”看起来一样，同步照常启动）
// • first：先显示告知页（排在以后的通知说明、麦克风说明之前，那几屏也挂在这个关口后面）；做完再画 App
// • updated：留给“隐私说明更新了”那一屏（还没做），现在直接进 App
// • none、读失败（断网、超时、出错）：直接进 App，不挡
// • 做完时地址还停在 #/onboarding（直接打开过这个路由）：换到今天页，免得进 App 后再显示一遍告知页
import { useCallback, useState, type ReactNode } from 'react';
import { navigate, parseHash } from '../../../app/router.ts';
import type { ConsentApi } from '../hooks/useConsent.ts';
import { defaultConsentWiringDeps, useConsentApi, useConsentHandlers, useNoticeState, type ConsentWiringDeps } from '../hooks/useConsentWiring.ts';
import ConsentPage from './ConsentPage.tsx';

export interface ConsentGateProps {
  /** 关口放行后画的东西（App） */
  children: ReactNode;
  /** 测试用：换掉接口和回调里的写 ai.enabled、离开设备 */
  api?: ConsentApi;
  wiring?: ConsentWiringDeps;
}

export default function ConsentGate({ children, api: injected, wiring = defaultConsentWiringDeps }: ConsentGateProps) {
  const shared = useConsentApi();
  const api = injected ?? shared;
  const notice = useNoticeState(api);
  const [done, setDone] = useState(false);
  const finish = useCallback(() => {
    if (parseHash(window.location.hash).name === 'onboarding') void navigate('today');
    setDone(true);
  }, []);
  const handlers = useConsentHandlers(finish, wiring);
  if (notice === 'pending') return null;
  if (notice === 'first' && !done) return <ConsentPage api={api} {...handlers} />;
  return <>{children}</>;
}
