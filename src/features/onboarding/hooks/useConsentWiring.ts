// 告知与同意页的接线（接手清单 CONSENT-wire ①③④；架构 15.5、0.40、0.41）
// • 小容器：用 platform/supabase 的 getSupabase 建 createConsentApi，整个页面共用一个（A27：ui 不能引 data，所以放在 hooks）
// • useNoticeState：只问一次 noticeState()；读失败（断网、超时、出错）按 'error' 交回，由调用方放行进 App。
//   给了 limitMs（启动关口用 CONSENT_GATE_MS，CONSENT-sugg ①）时到点也按 'error' 交回，之后才回来的结果丢掉
// • useConsentHandlers：ConsentPage 的四个必填回调
//   - onDone(agreed)：服务器已记下；agreed 为 true 时经 settings 同步写 ai.enabled = true（core/ai-settings.ts 的 writeAiSwitchSettled，走 outbox；
//     服务器只在撤回时写 false）；本机还没拉到服务器那一行、insert 被拒时，它等同步拉下那一行再 patch（CONSENT-sugg ②）。
//     写不进本机（本机库不可用等）不挡进 App、不提示——同意已记在服务器上，ai.enabled 没写上时 AI 只是还没打开，设置 › 语音与 AI 能再开
//   - onRevoked：会话不认 → 按“被移除”清本机、回登录页（data/consent-exit.ts，调现有出口 wipeOnRemoved）
//   - onDisabled：account_disabled → 同一套，退出原因记 disabled（登录页 auth.exit.disabled，架构 4.3 ②）
//   - onSkip：R-239 没法保存选择 → 直接进 App
import { useCallback, useEffect, useMemo, useState } from 'react';
import { writeAiSwitchSettled } from '../../../core/ai-settings.ts';
import { getSupabase } from '../../../platform/supabase/client.ts';
import { createConsentApi, type ConsentApi, type NoticeState } from '../data/consent-api.ts';
import { leaveThisDevice } from '../data/consent-exit.ts';
import type { ConsentHandlers } from './useConsent.ts';

export type { NoticeState };

let shared: ConsentApi | null = null;

/** 整个页面共用的 ConsentApi（懒建） */
export function consentApi(): ConsentApi {
  shared ??= createConsentApi(getSupabase);
  return shared;
}

export function useConsentApi(): ConsentApi {
  return useMemo(() => consentApi(), []);
}

export type NoticeView = 'pending' | NoticeState | 'error';

/**
 * 启动关口最多等多久（CONSENT-sugg ①）：noticeState 自己的超时是 8 秒（CONSENT_SLOW_MS），慢网时整屏空白太久。
 * 到点按读失败放行进 App：服务器端没有同意记录就不送 AI（aiAllowed），这次没显示的告知页下次打开再问
 */
export const CONSENT_GATE_MS = 5000;

/**
 * 问一次 noticeState()；给了 limitMs 时到点按 'error'；卸载后、到点后晚到的结果丢掉。
 * 给了 startedAt（Date.now() 毫秒）时上限从那一刻算起（K6-sugg3 ④：GatedApp 挂上时，含关口分包加载），已经过了就当场按 'error'
 */
export function useNoticeState(api: ConsentApi, limitMs?: number, startedAt?: number): NoticeView {
  const [view, setView] = useState<NoticeView>('pending');
  useEffect(() => {
    let live = true;
    const settle = (v: NoticeView): void => {
      if (!live) return;
      live = false;
      setView(v);
    };
    const left = limitMs === undefined ? undefined : startedAt === undefined ? limitMs : Math.max(0, limitMs - (Date.now() - startedAt));
    const timer = left === undefined ? undefined : setTimeout(() => settle('error'), left);
    api.noticeState().then(
      (r) => settle(r.ok ? r.value : 'error'),
      () => settle('error'),
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, limitMs, startedAt]);
  return view;
}

export interface ConsentWiringDeps {
  enableAi(): Promise<unknown>;
  /** sid：被拒那次请求用的会话（K6-sugg4 ①），离开时只删它 */
  leave(code: 'session_revoked' | 'account_disabled', sid: string | null): Promise<void>;
}

export const defaultConsentWiringDeps: ConsentWiringDeps = {
  enableAi: () => writeAiSwitchSettled({ key: 'ai.enabled', value: true }),
  leave: (code, sid) => leaveThisDevice(code, sid),
};

/** ConsentPage 的四个回调；finish = 进 App（或回到原来的页面） */
export function useConsentHandlers(finish: () => void, deps: ConsentWiringDeps = defaultConsentWiringDeps): ConsentHandlers {
  const onDone = useCallback(
    (agreed: boolean) => {
      if (agreed) void deps.enableAi().catch(() => undefined);
      finish();
    },
    [deps, finish],
  );
  const onRevoked = useCallback((sid: string | null) => void deps.leave('session_revoked', sid), [deps]);
  const onDisabled = useCallback((sid: string | null) => void deps.leave('account_disabled', sid), [deps]);
  return { onDone, onRevoked, onDisabled, onSkip: finish };
}

/** 测试用 */
export function resetConsentApiForTest(): void {
  shared = null;
}
