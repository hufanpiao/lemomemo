// 告知与同意页的接线（架构 15.5）：整个页面共用一个 createConsentApi；noticeState 先走快读，读不了再退回 supabase-js
// 不变量：useNoticeState 只问一次，读失败或到 limitMs 都按 'error' 交回、放行进 App
// 不变量：onRevoked、onDisabled 经 data/consent-exit.ts 交 core/device-exit.ts（被移除先查 session_fate 才清库）；同意后写 ai.enabled 写不进不挡进 App
// 详细说明见 docs/10-架构/历史版本/文件头原文-2026-11-11退出链路整改.md
import { useCallback, useEffect, useMemo, useState } from 'react';
import { writeAiSwitchSettled } from '../../../core/ai-settings.ts';
import { buildInfo } from '../../../platform/env.ts';
import { appFetch } from '../../../platform/http.ts';
import { readSessionAccessToken, readSessionId } from '../../../platform/session.ts';
import { getSupabase } from '../../../platform/supabase/client.ts';
import { REFRESH_MARGIN_MS } from '../../../platform/supabase/sync-errors.ts';
import { createConsentApi, createRestNoticeRead, CONSENT_HARD_MS, CONSENT_SLOW_MS, type ConsentApi, type NoticeState } from '../data/consent-api.ts';
import { leaveThisDevice } from '../data/consent-exit.ts';
import { setConsentStale } from '../../../kit/state/consent-fresh.ts';
import type { ConsentHandlers } from './useConsent.ts';

export type { NoticeState };

let shared: ConsentApi | null = null;

/** 整个页面共用的 ConsentApi（懒建） */
export function consentApi(): ConsentApi {
  shared ??= createConsentApi(getSupabase, CONSENT_SLOW_MS, CONSENT_HARD_MS, undefined, {
    envReady: Boolean(buildInfo.supabaseUrl && buildInfo.anonKey),
    fastRead: createRestNoticeRead({
      supabaseUrl: buildInfo.supabaseUrl,
      anonKey: buildInfo.anonKey,
      readToken: () => readSessionAccessToken(),
      fetch: appFetch,
      now: () => Date.now(),
      marginMs: REFRESH_MARGIN_MS,
    }),
  });
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
      (r) => {
        // 记下同意版本是不是明确过期（S1，kit/state/consent-fresh.ts）：关口已经超时放行了也记，打字条据此不发 ai-parse
        if (r.ok) setConsentStale(r.value === 'first' || r.value === 'updated', readSessionId());
        settle(r.ok ? r.value : 'error');
      },
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
  /** sid：被拒那次请求用的会话（K6-sugg4 ①），离开时只删它。false = 探测说账号正常、没离开（data/consent-exit.ts） */
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
      setConsentStale(!agreed, readSessionId()); // 服务器已记下当前版本；不同意时 ai.enabled 同步回来之前也不发（S1、安全复审）
      if (agreed) void deps.enableAi().catch(() => undefined);
      finish();
    },
    [deps, finish],
  );
  const onRevoked = useCallback((sid: string | null) => void deps.leave('session_revoked', sid), [deps]);
  // 探测说账号正常：留在告知页，按设置页的口径提示一句通用错误（onStay；PROBE / DISABLED-probe-later 遗留）
  const onDisabled = useCallback(
    (sid: string | null, onStay?: () => void) =>
      void deps.leave('account_disabled', sid).then((left) => (left === false ? onStay?.() : undefined), () => undefined),
    [deps],
  );
  return { onDone, onRevoked, onDisabled, onSkip: finish };
}
