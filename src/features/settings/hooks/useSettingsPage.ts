// 设置页（B1 K9 骨架）的总 hook：把接口、离开本机、设备列表、中韩切换接在一起
// 测试经 deps 换掉接口、清本机和跳转、时钟
import { useMemo } from 'react';
import { getSupabase } from '../../../platform/supabase/client.ts';
import { defaultExitDeps } from '../data/local.ts';
import { createSettingsApi, type SettingsApi } from '../data/settings-api.ts';
import { useDevices } from './useDevices.ts';
import { useLocaleSwitch } from './useLocaleSwitch.ts';
import { useSessionExit, type ExitDeps } from './useSessionExit.ts';

export type { SettingsApi } from '../data/settings-api.ts';
export type { ExitDeps, ExitNotice } from './useSessionExit.ts';

export interface SettingsDeps {
  api?: SettingsApi;
  exit?: ExitDeps;
  /** 当前时间（毫秒）；要传稳定的函数 */
  now?: () => number;
  /** 离开本机的提示后自动回登录页的等待时间 */
  redirectMs?: number;
  /** “退出这台设备”服务器部分的总超时 */
  exitTimeoutMs?: number;
  /** 跳登录页前最多等清理多久 */
  leaveWaitMs?: number;
}

export function useSettingsPage(deps: SettingsDeps = {}) {
  const exitDeps = deps.exit ?? defaultExitDeps;
  const api = useMemo(() => deps.api ?? createSettingsApi(getSupabase, (sid) => exitDeps.clearLocalSessionIf(sid)), [deps.api, exitDeps]);
  const exit = useSessionExit(api, exitDeps, {
    ...(deps.redirectMs === undefined ? {} : { redirectMs: deps.redirectMs }),
    ...(deps.exitTimeoutMs === undefined ? {} : { exitTimeoutMs: deps.exitTimeoutMs }),
    ...(deps.leaveWaitMs === undefined ? {} : { leaveWaitMs: deps.leaveWaitMs }),
  });
  const devices = useDevices({
    api,
    onRevoked: exit.onRevoked,
    onSignedOut: exit.onSignedOut,
    signOutHere: exit.signOutHere,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const locale = useLocaleSwitch(api, exit.onRevoked, exit.onSignedOut);
  return { exit, devices, locale };
}
