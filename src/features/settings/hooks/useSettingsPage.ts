// 设置页（B1 K9 骨架）的总 hook：把接口、离开本机、设备列表、中韩切换、导出和注销（R-256 ②⑤）接在一起
// 测试经 deps 换掉接口、清本机和跳转、时钟
import { useCallback, useMemo, useRef } from 'react';
import { saveFile } from '../../../platform/save-file.ts';
import { readSessionEmail } from '../../../platform/session.ts';
import { getSupabase } from '../../../platform/supabase/client.ts';
import { createAccountApi, EXPORT_MIME, type AccountApi, type ExportFile } from '../data/account-api.ts';
import { createLeaveAccount, leaveForDisabled, type DisabledLeaveDeps, type LeaveAccount } from '../data/account-exit.ts';
import { createRecentExportsApi, type RecentExportsApi } from '../data/recent-exports.ts';
import { defaultExitDeps, readLocalDeviceId } from '../data/local.ts';
import { createSettingsApi, type SettingsApi } from '../data/settings-api.ts';
import type { AccountActionDeps } from './useAccountActions.ts';
import { useDevices } from './useDevices.ts';
import { useLocaleSwitch } from './useLocaleSwitch.ts';
import { useSessionExit, type ExitDeps } from './useSessionExit.ts';

export type { SettingsApi } from '../data/settings-api.ts';
export { orderSections, type SettingsSectionId } from '../data/sections.ts';
export type { ExitDeps, ExitNotice } from './useSessionExit.ts';

export interface SettingsDeps {
  api?: SettingsApi;
  exit?: ExitDeps;
  /** account 函数（导出、注销） */
  account?: AccountApi;
  /** 注销成功、账号停用或冷静期时离开本机（默认 data/account-exit.ts） */
  leaveAccount?: LeaveAccount;
  /** 本机 meta 里的设备行 id（默认 data/local.ts 的 readLocalDeviceId） */
  readDeviceId?: () => Promise<string | null>;
  /** 设置 › 账号 › 最近的导出（默认经 RLS 读本人的 logs，data/recent-exports.ts） */
  recentExports?: RecentExportsApi;
  /** 存导出的文件（默认 platform/save-file.ts） */
  saveExport?: AccountActionDeps['save'];
  /** 当前时间（毫秒）；要传稳定的函数 */
  now?: () => number;
  /** 离开本机的提示后自动回登录页的等待时间 */
  redirectMs?: number;
  /** “退出这台设备”服务器部分的总超时 */
  exitTimeoutMs?: number;
  /** 跳登录页前最多等清理多久 */
  leaveWaitMs?: number;
  /** 设置 › 账号标题下的当前登录邮箱（R-275；默认 platform/session.ts 的 readSessionEmail，只读本机会话、不联网；读不到为 null，这一行不显示） */
  readEmail?: () => string | null;
  /** 测试用：换掉 account_disabled 的探测（默认 platform/account-status.ts 的 exitForDisabled） */
  resolveDisabled?: DisabledLeaveDeps['resolve'];
}

export function useSettingsPage(deps: SettingsDeps = {}) {
  const exitDeps = deps.exit ?? defaultExitDeps;
  const api = useMemo(() => deps.api ?? createSettingsApi(getSupabase, (sid) => exitDeps.clearLocalSessionIf(sid)), [deps.api, exitDeps]);
  const exit = useSessionExit(api, exitDeps, {
    ...(deps.redirectMs === undefined ? {} : { redirectMs: deps.redirectMs }),
    ...(deps.exitTimeoutMs === undefined ? {} : { exitTimeoutMs: deps.exitTimeoutMs }),
    ...(deps.leaveWaitMs === undefined ? {} : { leaveWaitMs: deps.leaveWaitMs }),
  });
  const leave = useMemo(() => deps.leaveAccount ?? createLeaveAccount(), [deps.leaveAccount]);
  const { onRevoked, onSignedOut } = exit;
  // settings-api 的 account_disabled（RLS 一路，分不清停用和冷静期）：先探测再定（R-256 ③；探测不出按 disabled_unsure）
  // 设备列表和改语言共用这一个：探测中（probing）再来的不再探测（第六轮审查建议 ③，同一时刻只探测一次）；
  // 探测说账号正常（没离开）就放开，下次再遇到可以再探测；离开了就一直挡着。
  // onStay：探测说账号正常时通知调用方改显示通用错误（不说停用或冷静期）；探测中再来的也排进去，一起通知
  const probing = useRef(false);
  const stays = useRef<(() => void)[]>([]);
  const onDisabled = useCallback(
    (sid: string | null, onStay?: () => void) => {
      if (onStay) stays.current.push(onStay);
      if (probing.current) return;
      probing.current = true;
      const d = { leave, onRevoked, ...(deps.resolveDisabled ? { resolve: deps.resolveDisabled } : {}) };
      const stay = (): void => {
        probing.current = false;
        const fns = stays.current;
        stays.current = [];
        fns.forEach((f) => f());
      };
      void leaveForDisabled(sid, d).then((left) => (left ? undefined : stay()), stay);
    },
    [leave, onRevoked, deps.resolveDisabled],
  );
  const devices = useDevices({
    api,
    onRevoked: exit.onRevoked,
    onSignedOut: exit.onSignedOut,
    onDisabled,
    signOutHere: exit.signOutHere,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const locale = useLocaleSwitch(api, exit.onRevoked, exit.onSignedOut, onDisabled);
  const accountApi = useMemo(() => deps.account ?? createAccountApi(getSupabase), [deps.account]);
  const account: AccountActionDeps = useMemo(
    () => ({
      api: accountApi,
      leave,
      onRevoked,
      onSignedOut,
      ...(deps.resolveDisabled ? { resolveDisabled: deps.resolveDisabled } : {}),
      readDeviceId: deps.readDeviceId ?? readLocalDeviceId,
      save: deps.saveExport ?? ((f: ExportFile) => saveFile(f.blob, f.name, EXPORT_MIME)),
    }),
    [accountApi, leave, onRevoked, onSignedOut, deps.resolveDisabled, deps.readDeviceId, deps.saveExport],
  );
  const recentExports = useMemo(
    () => deps.recentExports ?? createRecentExportsApi(getSupabase, deps.now ? { now: deps.now } : {}),
    [deps.recentExports, deps.now],
  );
  const readEmail = deps.readEmail ?? readSessionEmail;
  const email = useMemo(() => {
    try {
      return readEmail();
    } catch {
      return null;
    }
  }, [readEmail]);
  return { exit, devices, locale, account, recentExports, email };
}
