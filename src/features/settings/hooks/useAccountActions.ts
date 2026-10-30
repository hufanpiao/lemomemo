// 设置 › 数据 › 导出全部、设置 › 账号 › 注销账号（R-256 ②⑤；架构第 6 节 account、0.29 续第 93、96、129、131 条）
// • 导出：在 useExport.ts（0.47 起分片取回、中断后继续）；这里留共用的依赖和 handleAccountLoss
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
        // 查状态只查到会话已失效（T4 / 安全审查 H1）：提示“没能确认注销是否已经办好”，会话照删
        await d.leave(r.value.unsure ? 'deletion_unsure' : 'pending_deletion', r.value.sid, { revoked: true });
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
