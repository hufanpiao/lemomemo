// 改东西的几个动作：改用自己的密钥（own_use）、改回柠檬记的（own_off）、删密钥（own_delete）、存这家密钥（admin_key）、某项换哪家（admin_route）、
// 联网搜索勾哪几家（admin_web_route）
// • 同一时间只做一件（busy 是 state，要等重渲染才灰掉：用 ref 防手快连点发两次，同 plus 的 useClaudeLink）
// • 做完不管成不成都按服务器重读（mine / admin_get）：超时时服务器那边可能已经做完了，不凭这一次的回包猜
// • 运行日志只记动作名、服务商名、项名、结果码、耗时（不记模型名、密钥）
import { useCallback, useRef, useState } from 'react';
import type { AiRouteTask, AiWebName, TestFailCode } from '../../../../shared/schema/ai-provider.ts';
import type { PickName } from '../data/rules.ts';
import { clock } from '../../../platform/clock.ts';
import { adminKey, adminRoute, adminWeb, ownDelete, ownOff, ownUse, type KeyReq, type ProvErr, type ProvResult, type WriteOut } from '../data/provider-api.ts';
import { logResult, reloadAdmin, reloadMine } from './useProvider.ts';

/** 做完的结果：done 成了；fail 服务器先试没通（带原因）；err 没做成 */
export type ActOut = { kind: 'done' } | { kind: 'fail'; code: TestFailCode } | { kind: 'err'; err: ProvErr };

const outOf = (r: ProvResult<WriteOut>): ActOut => (!r.ok ? { kind: 'err', err: r.err } : r.value.done ? { kind: 'done' } : { kind: 'fail', code: r.value.code });

export interface Acts {
  busy: string | null;
  /** 最近一次没做成的结果（界面写一句）；开始下一件时清掉 */
  last: Exclude<ActOut, { kind: 'done' }> | null;
  clear(): void;
  ownUse(r: KeyReq): Promise<ActOut>;
  ownOff(): Promise<ActOut>;
  ownDelete(): Promise<ActOut>;
  adminKey(r: KeyReq): Promise<ActOut>;
  adminRoute(task: AiRouteTask, p: PickName): Promise<ActOut>;
  /** 联网搜索改成勾这几家（admin_web_route） */
  adminWeb(picks: readonly AiWebName[]): Promise<ActOut>;
}

export function useActs(): Acts {
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<Acts['last']>(null);
  const running = useRef(false);
  const go = useCallback(async (name: string, provider: string | undefined, fn: () => Promise<ProvResult<WriteOut>>, reload: () => Promise<void>): Promise<ActOut> => {
    if (running.current) return { kind: 'err', err: 'failed' };
    running.current = true;
    setBusy(name);
    setLast(null);
    const at = clock.now();
    try {
      const r = await fn();
      logResult(name, r, at, provider);
      const out = outOf(r);
      await reload();
      if (out.kind !== 'done') setLast(out);
      return out;
    } finally {
      running.current = false;
      setBusy(null);
    }
  }, []);
  return {
    busy,
    last,
    clear: useCallback(() => setLast(null), []),
    ownUse: (r) => go('own_use', r.provider, () => ownUse(r), reloadMine),
    ownOff: () => go('own_off', undefined, () => ownOff(), reloadMine),
    ownDelete: () => go('own_delete', undefined, () => ownDelete(), reloadMine),
    adminKey: (r) => go('admin_key', r.provider, () => adminKey(r), async () => {
      await Promise.all([reloadAdmin(), reloadMine()]);
    }),
    adminRoute: (task, p) => go(`admin_route_${task}`, p, () => adminRoute(task, p), async () => {
      await Promise.all([reloadAdmin(), reloadMine()]);
    }),
    // 日志里的“服务商”写勾的几家（只是名字，不带搜索词）
    adminWeb: (picks) => go('admin_route_web', picks.join('+'), () => adminWeb(picks), reloadAdmin),
  };
}
