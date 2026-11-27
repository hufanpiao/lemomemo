// 告知页关口一侧的接线：整个页面共用一个 createConsentApi；noticeState 先走快读，读不了再退回 supabase-js
// 不变量：useNoticeState 只问一次，读失败或到 limitMs 都按 'error' 交回、放行进 App
// 告知页的四个回调（离开设备、写 ai.enabled）在 hooks/useConsentHandlers.ts，跟告知页一起懒加载，已经同意过的人首屏不下载
import { useEffect, useMemo, useState } from 'react';
import { msLeft } from '../../../platform/gate-limit.ts';
import { buildInfo } from '../../../platform/env.ts';
import { appFetch } from '../../../platform/http.ts';
import { readSessionAccessToken, readSessionId } from '../../../platform/session.ts';
import { getSupabase } from '../../../platform/supabase/client.ts';
import { REFRESH_MARGIN_MS } from '../../../platform/supabase/refresh-margin.ts';
import { createConsentApi, createRestNoticeRead, CONSENT_HARD_MS, CONSENT_SLOW_MS, type ConsentApi, type NoticeState } from '../data/consent-api.ts';
import { setConsentStale } from '../../../kit/state/consent-fresh.ts';

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
 * 问一次 noticeState()；给了 limitMs 时到点按 'error'；卸载后、到点后晚到的结果丢掉。
 * 给了 startedAt（Date.now() 毫秒）时上限从那一刻算起（GatedApp 挂上时，含关口分包加载），已经过了就当场按 'error'
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
    const left = limitMs === undefined ? undefined : startedAt === undefined ? limitMs : msLeft(limitMs, startedAt);
    const timer = left === undefined ? undefined : setTimeout(() => settle('error'), left);
    api.noticeState().then(
      (r) => {
        // 记下同意版本是不是明确过期（kit/state/consent-fresh.ts）：关口已经超时放行了也记，打字条据此不发 ai-parse
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
