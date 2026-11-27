// 设置页的总 hook：把接口、离开本机、设备列表、中韩切换、导出和注销、换头像接在一起
// 测试经 deps 换掉接口、清本机和跳转、时钟
import { useCallback, useMemo } from 'react';
import { getBoot } from '../../../core/boot.ts';
import { lossWhy } from '../../../platform/supabase/loss-why.ts';
import type { ProbedExit } from '../../../platform/account-status.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { saveFile } from '../../../platform/save-file.ts';
import { readSessionEmail } from '../../../platform/session.ts';
import { getSupabase } from '../../../platform/supabase/client.ts';
import { createAccountApi, EXPORT_MIME, type AccountApi, type ExportFile } from '../data/account-api.ts';
import {
  createDisabledGate, createFollowSignOut, createLeaveAccount, defaultAccountLeaveDeps, exitForAccountDisabled, type DisabledGateDeps, type LeaveAccount,
} from '../../../core/account-leave.ts';
import { createRecentExportsApi, type RecentExportsApi } from '../data/recent-exports.ts';
import { defaultSignOutHereDeps, readLocalDeviceId } from '../data/local.ts';
import { createSettingsApi, type SettingsApi } from '../data/settings-api.ts';
import type { AccountActionDeps } from './useAccountActions.ts';
import type { HotkeyApi } from './useQuickAddHotkey.ts';
import { useDevices } from './useDevices.ts';
import { useLocaleSwitch } from './useLocaleSwitch.ts';
import { useMeAvatarEdit } from './useMeAvatarEdit.ts';
import { useSessionExit, type SignOutHereDeps } from './useSessionExit.ts';

export type { SettingsApi } from '../data/settings-api.ts';
export { cardsOf, deskGroupOf, deskRowsOf, orderSections, SETTINGS_DESK_GROUPS, type SettingsCardId, type SettingsDeskGroupId, type SettingsSectionId } from '../data/sections.ts';
export type { SignOutHereDeps, SignOutNotice } from './useSessionExit.ts';

export interface SettingsDeps {
  /** 快速记录热键（默认 platform/desktop-hotkey.ts；要传稳定的对象） */
  hotkey?: HotkeyApi;
  api?: SettingsApi;
  exit?: SignOutHereDeps;
  /** account 函数（导出、注销） */
  account?: AccountApi;
  /** 注销成功、账号停用或冷静期、会话不认（removed）时离开本机（默认 core/account-leave.ts，即 core/device-exit.ts 的 exitDevice） */
  leaveAccount?: LeaveAccount;
  /** 请求发现本机已经没有会话时离开本机（默认 core/account-leave.ts 的 createFollowSignOut，同别的标签页退出） */
  followSignOut?: () => void;
  /** 本机 meta 里的设备行 id（默认 data/local.ts 的 readLocalDeviceId） */
  readDeviceId?: () => Promise<string | null>;
  /** 设置 › 账号 › 最近的导出（默认经 RLS 读本人的 logs，data/recent-exports.ts） */
  recentExports?: RecentExportsApi;
  /** 存导出的文件（默认 platform/save-file.ts） */
  saveExport?: AccountActionDeps['save'];
  /** 当前时间（毫秒）；要传稳定的函数 */
  now?: () => number;
  /** “服务器上的这次登录暂时没能吊销”提示后自动回登录页的等待时间 */
  redirectMs?: number;
  /** “退出这台设备”服务器部分的总超时 */
  exitTimeoutMs?: number;
  /** 设置 › 账号标题下的当前登录邮箱（默认 platform/session.ts 的 readSessionEmail，只读本机会话、不联网；读不到为 null，这一行不显示） */
  readEmail?: () => string | null;
  /** 测试用：换掉 account_disabled 的探测（默认 platform/account-status.ts 的 probeForSid）；要传稳定的函数 */
  resolveDisabled?: DisabledGateDeps['resolve'];
}

export function useSettingsPage(deps: SettingsDeps = {}) {
  const exitDeps = deps.exit ?? defaultSignOutHereDeps;
  const api = useMemo(() => deps.api ?? createSettingsApi(getSupabase, (sid) => exitDeps.clearLocalSessionIf(sid)), [deps.api, exitDeps]);
  const exit = useSessionExit(api, exitDeps, {
    ...(deps.redirectMs === undefined ? {} : { redirectMs: deps.redirectMs }),
    ...(deps.exitTimeoutMs === undefined ? {} : { exitTimeoutMs: deps.exitTimeoutMs }),
  });
  // 设置页的“被移除”记录成 settings 一路（lemo.authloss 的 path）
  const leave = useMemo(() => deps.leaveAccount ?? createLeaveAccount({ ...defaultAccountLeaveDeps, authPath: 'settings' }), [deps.leaveAccount]);
  const follow = useMemo(() => deps.followSignOut ?? createFollowSignOut(), [deps.followSignOut]);
  // 会话不认、本机没有会话：和主 App 同一条退出管线（core/device-exit.ts 的 exitDevice，同一页只退出一次）
  const onRevoked = useCallback(
    (sid: string | null, cause?: unknown) => {
      // 带上服务器给的原始码和状态（只记 kind=revoked 的话 exitDevice 收不到 status，查不出是哪一种）
      const why = cause === undefined ? null : lossWhy(cause);
      rlog(`settings session_lost kind=revoked code=${why?.code ?? '-'} status=${why?.status ?? 0}`);
      void (why ? leave('removed', sid, { status: why.status }) : leave('removed', sid));
    },
    [leave],
  );
  const onSignedOut = useCallback(() => {
    rlog('settings session_lost kind=signed_out');
    follow();
  }, [follow]);
  // account_disabled（设备列表、改语言、换头像、导出、注销）：先探测再定（core/account-leave.ts 的 exitForAccountDisabled，和主 App 同一个入口）。
  // 这一页一个闸：同一时刻只探测一次，探测中再来的合用那一次；探测说账号正常（active）就各自调 onStay 改显示通用错误、放开，下次再遇到可以再探；
  // 离开了就一直挡着。探测说会话已失效（removed）走 onRevoked（同别的出口）
  const gate = useMemo(() => createDisabledGate(deps.resolveDisabled ? { resolve: deps.resolveDisabled } : {}), [deps.resolveDisabled]);
  const onDisabled = useCallback(
    (sid: string | null, onStay?: () => void) => {
      const go = (r: ProbedExit, s: string | null): Promise<void> | void => (r === 'removed' ? onRevoked(s) : leave(r, s));
      void exitForAccountDisabled(sid, { gate, getBoot, leave: go }).then((r) => (r === 'active' ? onStay?.() : undefined), () => onStay?.());
    },
    [gate, leave, onRevoked],
  );
  const devices = useDevices({
    api,
    onRevoked,
    onSignedOut,
    onDisabled,
    signOutHere: exit.signOutHere,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const locale = useLocaleSwitch(api, onRevoked, onSignedOut, onDisabled);
  const avatarExits = useMemo(() => ({ onRevoked, onSignedOut, onDisabled }), [onRevoked, onSignedOut, onDisabled]);
  const avatar = useMeAvatarEdit(api, avatarExits);
  const accountApi = useMemo(() => deps.account ?? createAccountApi(getSupabase), [deps.account]);
  const account: AccountActionDeps = useMemo(
    () => ({
      api: accountApi,
      leave,
      onRevoked,
      onSignedOut,
      onDisabled,
      readDeviceId: deps.readDeviceId ?? readLocalDeviceId,
      save: deps.saveExport ?? ((f: ExportFile) => saveFile(f.blob, f.name, EXPORT_MIME)),
    }),
    [accountApi, leave, onRevoked, onSignedOut, onDisabled, deps.readDeviceId, deps.saveExport],
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
  return { exit, devices, locale, account, recentExports, email, avatar };
}
