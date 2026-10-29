// 告知与同意页的接线（接手清单 CONSENT-wire ①③④；架构 15.5、0.40、0.41）
// • 小容器：用 platform/supabase 的 getSupabase 建 createConsentApi，整个页面共用一个（A27：ui 不能引 data，所以放在 hooks）
// • useNoticeState：只问一次 noticeState()；读失败（断网、超时、出错）按 'error' 交回，由调用方放行进 App
// • useConsentHandlers：ConsentPage 的四个必填回调
//   - onDone(agreed)：服务器已记下；agreed 为 true 时经 settings 同步写 ai.enabled = true（core/ai-settings.ts，走 outbox；
//     服务器只在撤回时写 false）；写不进本机（本机库不可用等）不挡进 App、不提示——同意已记在服务器上，
//     ai.enabled 没写上时 AI 只是还没打开，设置 › 语音与 AI 能再开
//   - onRevoked：会话不认 → 按“被移除”清本机、回登录页（data/consent-exit.ts，调现有出口 wipeOnRemoved）
//   - onDisabled：account_disabled → 同一套，退出原因记 disabled（登录页 auth.exit.disabled，架构 4.3 ②）
//   - onSkip：R-239 没法保存选择 → 直接进 App
import { useCallback, useEffect, useMemo, useState } from 'react';
import { writeAiSwitch } from '../../../core/ai-settings.ts';
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

/** 问一次 noticeState()；卸载后晚到的结果丢掉 */
export function useNoticeState(api: ConsentApi): NoticeView {
  const [view, setView] = useState<NoticeView>('pending');
  useEffect(() => {
    let live = true;
    api.noticeState().then(
      (r) => live && setView(r.ok ? r.value : 'error'),
      () => live && setView('error'),
    );
    return () => {
      live = false;
    };
  }, [api]);
  return view;
}

export interface ConsentWiringDeps {
  enableAi(): Promise<unknown>;
  leave(code: 'session_revoked' | 'account_disabled'): Promise<void>;
}

export const defaultConsentWiringDeps: ConsentWiringDeps = {
  enableAi: () => writeAiSwitch({ key: 'ai.enabled', value: true }),
  leave: (code) => leaveThisDevice(code),
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
  const onRevoked = useCallback(() => void deps.leave('session_revoked'), [deps]);
  const onDisabled = useCallback(() => void deps.leave('account_disabled'), [deps]);
  return { onDone, onRevoked, onDisabled, onSkip: finish };
}

/** 测试用 */
export function resetConsentApiForTest(): void {
  shared = null;
}
