// 启动时的告知页关口（接手清单 CONSENT-wire ②；架构 15.5、0.40 R-239）：main.tsx 在线时先画它，放行（onPass）以后才画 App
// • 先问一次 noticeState()，结果回来以前什么也不画（#root 本来就是空的，和“等完再渲染”看起来一样，同步照常启动）
// • first：先显示告知页（排在以后的通知说明、麦克风说明之前，那几屏也挂在这个关口后面）；做完再放行
// • updated：留给“隐私说明更新了”那一屏（还没做），现在直接放行
// • none、读失败（断网、超时、出错）：直接放行，不挡
// • 关口自己的上限 CONSENT_GATE_MS（CONSENT-sugg ①）：慢网时最多空白这么久，到点按读失败放行；之后才回来的结果不管（下次打开再问）
// • 做完时地址还停在 #/onboarding（直接打开过这个路由）：换到今天页，免得进 App 后再显示一遍告知页
// • App 不画在关口里面（CONSENT-sugg ③）：main.tsx 的错误边界只包关口，关口出错或分包加载失败时放行画 App，App 自己出错不归它管（src/app/root.tsx）
import { useCallback, useEffect, useState } from 'react';
import { navigate, parseHash } from '../../../app/router.ts';
import type { ConsentApi } from '../hooks/useConsent.ts';
import {
  CONSENT_GATE_MS, defaultConsentWiringDeps, useConsentApi, useConsentHandlers, useNoticeState, type ConsentWiringDeps,
} from '../hooks/useConsentWiring.ts';
import ConsentPage from './ConsentPage.tsx';

export interface ConsentGateProps {
  /** 放行：该画 App 了（只调一次） */
  onPass: () => void;
  /** 测试用：换掉接口和回调里的写 ai.enabled、离开设备 */
  api?: ConsentApi;
  wiring?: ConsentWiringDeps;
  /** 测试用：关口最多等多久（默认 CONSENT_GATE_MS） */
  limitMs?: number;
}

export default function ConsentGate({ onPass, api: injected, wiring = defaultConsentWiringDeps, limitMs = CONSENT_GATE_MS }: ConsentGateProps) {
  const shared = useConsentApi();
  const api = injected ?? shared;
  const notice = useNoticeState(api, limitMs);
  const [done, setDone] = useState(false);
  const finish = useCallback(() => {
    if (parseHash(window.location.hash).name === 'onboarding') void navigate('today');
    setDone(true);
  }, []);
  const handlers = useConsentHandlers(finish, wiring);
  const showConsent = notice === 'first' && !done;
  const pass = notice !== 'pending' && !showConsent;
  useEffect(() => {
    if (pass) onPass();
  }, [pass, onPass]);
  return showConsent ? <ConsentPage api={api} {...handlers} /> : null;
}
