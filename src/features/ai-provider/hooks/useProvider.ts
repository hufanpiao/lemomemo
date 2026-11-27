// 设置 › 我的 AI、AI 服务商 两页读的东西：数据层在 ../data/provider-api.ts，共用的那份在 ../data/store.ts
// • useMine / useAdmin：订阅内存里那一份；refresh=true 的（二级页）进来重读一次，首页那两行只在还没读过时读
// • useUsage：今天 AI 用了几次（platform/ai-usage.ts，同 设置 › 语音与 AI），清零时刻按 current_tz（shared/logic/ai-quota.ts 的 quotaResetClock）
// • 运行日志（rlog）只记动作名、服务商名、结果码和耗时，不记模型名、不记密钥
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AdminGetRes, MineRes } from '../../../../shared/schema/ai-provider.ts';
import { quotaResetClock } from '../../../../shared/logic/ai-quota.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { readAiUsage, type AiUsage } from '../../../platform/ai-usage.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { adminGet, readMine, type ProvResult } from '../data/provider-api.ts';
import { adminBox, keepOrFail, mineBox, type Load } from '../data/store.ts';

/** 动作的结果记一行：“aiprov <动作> [p=服务商] ok|err=码 ms=耗时” */
export function logResult(action: string, r: ProvResult<unknown>, startedAt: number, provider?: string): void {
  const p = provider === undefined ? '' : ` p=${provider}`;
  rlog(`aiprov ${action}${p} ${r.ok ? 'ok' : `err=${r.err}`} ms=${Math.round(clock.now() - startedAt)}`);
}

let mineInflight: Promise<void> | null = null;
export function reloadMine(): Promise<void> {
  mineInflight ??= (async () => {
    const at = clock.now();
    const r = await readMine();
    logResult('mine', r, at);
    if (r.ok) mineBox.set({ kind: 'ok', value: r.value });
    else keepOrFail(mineBox);
  })().finally(() => {
    mineInflight = null;
  });
  return mineInflight;
}

let adminInflight: Promise<void> | null = null;
export function reloadAdmin(): Promise<void> {
  adminInflight ??= (async () => {
    const at = clock.now();
    const r = await adminGet();
    logResult('admin_get', r, at);
    if (r.ok) adminBox.set({ kind: 'ok', value: r.value });
    else keepOrFail(adminBox);
  })().finally(() => {
    adminInflight = null;
  });
  return adminInflight;
}

/** refresh：进来就重读（二级页）；不给只在还没读到时读（首页那两行） */
export function useMine(refresh = false): Load<MineRes> {
  const v = useSyncExternalStore(mineBox.subscribe, mineBox.get, mineBox.get);
  useEffect(() => {
    if (refresh || mineBox.get().kind !== 'ok') void reloadMine();
  }, [refresh]);
  return v;
}

export function useAdmin(): Load<AdminGetRes> {
  const v = useSyncExternalStore(adminBox.subscribe, adminBox.get, adminBox.get);
  useEffect(() => {
    void reloadAdmin();
  }, []);
  return v;
}

export type UsageView = { kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; usage: AiUsage; resetAt: string };

/** 今天 AI 用量 + 清零时刻（HH:MM，按 current_tz）；读不出来不当 0 次 */
export function useUsage(): UsageView {
  const [v, setV] = useState<UsageView>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    void readAiUsage().then((r) => {
      if (live) setV(r.ok ? { kind: 'ok', usage: r.value, resetAt: quotaResetClock(clock.now(), currentTz()) } : { kind: 'error' });
    });
    return () => {
      live = false;
    };
  }, []);
  return v;
}
