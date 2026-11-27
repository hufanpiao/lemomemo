// 启动时的告知页关口：main.tsx 在线时先画它，放行（onPass）以后才画 App
// • 先问一次 noticeState()，结果回来以前什么也不画（#root 本来就是空的，和“等完再渲染”看起来一样，同步照常启动）
// • first：先显示告知页（排在以后的通知说明、麦克风说明之前，那几屏也挂在这个关口后面）；做完再放行
// • updated（看过的版本低于 notice.min_consent_ver）：先显示“隐私说明更新了”那一屏（ConsentPage variant="updated"），做完再放行；
//   同意、不同意都走同一个 record_consent，把 consent_policy_ver 写成当前版本（服务器 RPC 不变）
// • none、读失败（断网、超时、出错）：直接放行，不挡
// • 关口自己的上限 GATE_LIMIT_MS（platform/gate-limit.ts）：慢网时最多空白这么久，到点按读失败放行；之后才回来的结果不管（下次打开再问）。
//   调用方给了 startedAt（src/app/root.tsx 的 GatedApp）时从那一刻算起：分包加载用掉的时间扣掉，只等剩下的；
//   挂上时调 onStart，调用方从此不再自己计时（已经显示的告知页不会被它打断）
// • 做完时地址还停在 #/onboarding（直接打开过这个路由）：换到今天页，免得进 App 后再显示一遍告知页
// • 告知页本身（ConsentPage）懒加载（首屏体积）：已经同意过的人（绝大多数冷启动）不下载它；
//   要显示时才加载，加载中什么也不画（和等 noticeState 时一样）；分包加载失败归 main.tsx 包着关口的错误边界，照旧放行画 App
// • App 不画在关口里面：main.tsx 的错误边界只包关口，关口出错或分包加载失败时放行画 App，App 自己出错不归它管（src/app/root.tsx）
// • 回调那一套（离开设备、账号状态、多标签页通知、写 ai.enabled，hooks/useConsentHandlers.ts）也跟着告知页的容器 ConsentRoute 一起懒加载：
//   关口自己只问 noticeState，已经同意过的人首屏不下载它们
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { parseHash, replaceRoute } from '../../../app/router.ts';
import type { ConsentApi } from '../hooks/useConsent.ts';
import type { ConsentWiringDeps } from '../hooks/useConsentHandlers.ts';
import { GATE_LIMIT_MS, msLeft } from '../../../platform/gate-limit.ts';
import { useConsentApi, useNoticeState } from '../hooks/useConsentWiring.ts';

const loadRoute = () => import('./ConsentRoute.tsx');
const ConsentRoute = lazy(loadRoute);

export interface ConsentGateProps {
  /** 放行：该画 App 了（只调一次） */
  onPass: () => void;
  /** 测试用：换掉接口和回调里的写 ai.enabled、离开设备 */
  api?: ConsentApi;
  wiring?: ConsentWiringDeps;
  /** 关口最多等多久（默认 GATE_LIMIT_MS，platform/gate-limit.ts；GatedApp 传同一个值，测试可以改短） */
  limitMs?: number;
  /** 计时起点（Date.now() 的毫秒数）：不给就从关口挂上算起 */
  startedAt?: number;
  /** 关口挂上了（调用方停掉自己的计时） */
  onStart?: () => void;
}

export default function ConsentGate({
  onPass, api: injected, wiring, limitMs = GATE_LIMIT_MS, startedAt, onStart,
}: ConsentGateProps) {
  const shared = useConsentApi();
  const api = injected ?? shared;
  const notice = useNoticeState(api, limitMs, startedAt);
  useEffect(() => {
    onStart?.();
  }, [onStart]);
  const [done, setDone] = useState(false);
  const finish = useCallback(() => {
    // 告知页做完原地换成今天：左滑不回到告知页
    if (parseHash(window.location.hash).name === 'onboarding') void replaceRoute('today');
    setDone(true);
  }, []);
  // 告知页分包也受关口的时限管（不然分包挂住会一直空白）：从同一个起点算剩下的时间，到点还没加载好就放行，
  // 和 noticeState 超时一样（下次打开再问）；已经加载好、显示出来的告知页不会被打断
  const [t0] = useState(() => startedAt ?? Date.now());
  const [routeLate, setRouteLate] = useState(false);
  const wantConsent = (notice === 'first' || notice === 'updated') && !done;
  useEffect(() => {
    if (!wantConsent) return;
    let loaded = false;
    void loadRoute().then(() => {
      loaded = true;
    }, () => undefined);
    const timer = setTimeout(() => {
      if (!loaded) setRouteLate(true);
    }, msLeft(limitMs, t0));
    return () => clearTimeout(timer);
  }, [wantConsent, limitMs, t0]);
  const showConsent = wantConsent && !routeLate;
  const pass = notice !== 'pending' && !showConsent;
  useEffect(() => {
    if (pass) onPass();
  }, [pass, onPass]);
  return showConsent ? (
    <Suspense fallback={null}>
      <ConsentRoute api={api} {...(wiring ? { wiring } : {})} variant={notice === 'updated' ? 'updated' : 'first'} onFinish={finish} />
    </Suspense>
  ) : null;
}
