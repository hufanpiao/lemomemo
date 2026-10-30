// 设置 › 数据 › 导出全部、设置 › 账号 › 注销账号（R-256 ②⑤；架构第 6 节 account、0.29 续第 93、96、129、131 条）
// • 导出：读本机设备行 id → account export → 存文件（platform/save-file：电脑 download，iPhone 主屏幕版 share）。
//   成功后留着这份文件，界面给“再存一次”（分享面板被取消、没存上时不用再导一次，导出一天只有 3 次）
// • 注销：打开注销页先数没上传的（和退出登录确认框同一个 pendingCount）；提交 account delete，成功后离开本机（data/account-exit.ts）
// • 会话没了（session_revoked、unauthorized、401）走现有的“被移除”流程（useSessionExit.onRevoked）；本机没有会话走 onSignedOut；
//   账号停用、冷静期（account_disabled、account_pending_deletion）清本机、回登录页按原因提示（同 sync-wiring 的 disabled 事件）；
//   account_disabled 先探测再定（R-256 ③，data/account-exit.ts 的 leaveForDisabled；这一路经 requireActiveUser、码是精确的，
//   探测不出时仍按“已停用”）；探测说账号正常（active）就不离开，照常显示这次的错误
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SaveOutcome } from '../../../platform/save-file.ts';
import type { AccountApi, AccountErr, AccountFailure, ExportFile } from '../data/account-api.ts';
import { leaveForDisabled, type DisabledLeaveDeps, type LeaveAccount } from '../data/account-exit.ts';

export type { AccountErr } from '../data/account-api.ts';

export interface AccountActionDeps {
  api: AccountApi;
  readDeviceId(): Promise<string | null>;
  save(file: ExportFile): Promise<SaveOutcome>;
  leave: LeaveAccount;
  onRevoked(sid: string | null): void;
  onSignedOut(sid: string | null): void;
  /** 测试用：换掉 account_disabled 的探测（默认 platform/account-status.ts 的 exitForDisabled） */
  resolveDisabled?: DisabledLeaveDeps['resolve'];
}

type LossDeps = Pick<AccountActionDeps, 'leave' | 'onRevoked' | 'onSignedOut' | 'resolveDisabled'>;

/**
 * 会话没了、账号停用、冷静期：交给离开本机的处理；true = 已处理。
 * onStay：account_disabled 探测出账号正常、不离开时调——调用方显示通用错误（unknown），不说“已停用”（PROBE 遗留，和设备列表同一口径）
 */
export function handleAccountLoss(f: AccountFailure, d: LossDeps, onStay?: () => void): boolean {
  if (f.error === 'revoked') d.onRevoked(f.sid);
  else if (f.error === 'signed_out') d.onSignedOut(f.sid);
  else if (f.error === 'account_disabled') {
    const ld: DisabledLeaveDeps = { leave: d.leave, onRevoked: d.onRevoked, ...(d.resolveDisabled ? { resolve: d.resolveDisabled } : {}) };
    // 探测或离开抛错也当没离开（同 useSettingsPage）：不留未处理的 reject，导出按钮也不会一直停在“忙”
    void leaveForDisabled(f.sid, ld, 'disabled').then(
      (left) => {
        if (!left) onStay?.();
      },
      () => onStay?.(),
    );
  }
  else if (f.error === 'pending_deletion') void d.leave('pending_deletion', f.sid);
  else return false;
  return true;
}

export type ExportState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  /** saved：这次存下了没有（取消分享、分享被拒要再点一下、download 抛错都为 false） */
  | { kind: 'done'; file: ExportFile; saved: boolean }
  | { kind: 'error'; error: AccountErr };

/** onExported：导出成功（服务器已记下这一次）后调，设置 › 账号的“最近的导出”据此重读 */
export function useExport(d: AccountActionDeps, onExported?: () => void) {
  const [state, setState] = useState<ExportState>({ kind: 'idle' });
  /** “再存一次”正在存（防连点：存的过程中按钮禁用） */
  const [saving, setSaving] = useState(false);
  const running = useRef(false);
  const savingRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const store = useCallback(
    async (file: ExportFile): Promise<boolean> => {
      try {
        // 只有真存好了才算（取消、被拒要再点一下的都不算，界面给“再存一次”）
        const r = await d.save(file);
        return r === 'shared' || r === 'downloaded';
      } catch {
        return false;
      }
    },
    [d],
  );

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setState({ kind: 'busy' });
    try {
      const r = await d.api.exportAll(await d.readDeviceId());
      if (!alive.current) return;
      if (!r.ok) {
        const show = (error: AccountErr = r.error): void => {
          if (alive.current) setState({ kind: 'error', error });
        };
        if (!handleAccountLoss(r, d, () => show('unknown'))) show();
        return;
      }
      onExported?.();
      const saved = await store(r.value);
      if (alive.current) setState({ kind: 'done', file: r.value, saved });
    } finally {
      running.current = false;
    }
  }, [d, store, onExported]);

  /** 再存一次（不再调服务器） */
  const saveAgain = useCallback(async () => {
    if (state.kind !== 'done' || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await store(state.file);
      if (alive.current) setState({ kind: 'done', file: state.file, saved });
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
    }
  }, [state, store]);

  return { state, saving, run, saveAgain };
}

export type DeleteState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; error: AccountErr };

/** pendingCount：退出登录确认框用的那个（useSessionExit.pendingCount，先重新读库、最多等 2.5 秒） */
export function useDeleteAccount(d: Pick<AccountActionDeps, 'api' | 'leave' | 'onRevoked' | 'onSignedOut' | 'resolveDisabled'>, pendingCount: () => Promise<number | null>) {
  const [state, setState] = useState<DeleteState>({ kind: 'idle' });
  /** 没上传的条数：undefined = 还在数；null = 数不出来 */
  const [unsent, setUnsent] = useState<number | null | undefined>(undefined);
  const running = useRef(false);

  useEffect(() => {
    let live = true;
    pendingCount()
      .catch((): number | null => null)
      .then((n) => {
        if (live) setUnsent(n);
      });
    return () => {
      live = false;
    };
  }, [pendingCount]);

  const submit = useCallback(
    async (confirm: string) => {
      if (running.current) return;
      running.current = true;
      setState({ kind: 'busy' });
      const r = await d.api.requestDeletion(confirm.trim());
      if (r.ok) {
        // 保持“正在注销”直到跳走（running 不放开，不能再提交）
        // R-263 定的例外：R-262（冷静期不删会话）的前提是“探测出冷静期说明被拒那次的会话还活着”，这一路不成立——
        // 服务器在申请注销的同一事务里已吊销全部会话（supabase/functions/account/core.ts ④），留着只会让登录页探测出“会话失效”，所以照旧删
        await d.leave('pending_deletion', r.value.sid, { revoked: true });
        return;
      }
      running.current = false;
      const show = (error: AccountErr = r.error): void => setState({ kind: 'error', error });
      if (!handleAccountLoss(r, d, () => show('unknown'))) show();
    },
    [d],
  );

  return { state, unsent, submit };
}
