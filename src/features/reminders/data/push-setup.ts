// 设置 › 提醒 的推送状态和操作（B2 任务单 FA-1 留给 FA-4 的“通知开关在用户点按里请求权限”、FA-4 的第 105 条“移除它”；
// 架构 0.29 续第 105 条、3.3 claim_endpoint、5.3；TC-B2-71、R-282 ③）
// • 状态：exe（tauri）→ 电脑版用 Windows 通知；通知权限 granted / denied / default；启动时认领的结果（platform/push-status.ts）
// • 打开通知：必须在点按里调 Notification.requestPermission()（iOS 只认用户点按），给了以后马上订阅、认领（和启动同一份参数：platform/push-claim-run.ts 的 runPushClaim，带账号锁和设备登记）
// • 推送被同账号的另一条设备记录占着（endpoint_in_use）：install_id 和本机一样 → “这是这台设备以前的登录记录”；
//   不一样 → “被另一条设备记录“Y 的 Edge”（最近使用 <日期>）占着，多半是之前没联网时退出留下的”；不自动移除
// • 点“移除它”：先确认；rpc remove_device(holder.id)（服务器吊销那条记录的会话、删行），成功后自动再认领一次；再认领没接上时界面换成“重新接上”，只再认领
import { isTauri } from '../../../platform/env.ts';
import { notificationPermission, requestNotificationPermission } from '../../../platform/perm.ts';
import { INSTALL_ID_KEY } from '../../../platform/device-info.ts';
import type { EndpointHolder, EnsurePushOutcome } from '../../../platform/push-claim.ts';
import { runPushClaim } from '../../../platform/push-claim-run.ts';
import { getSupabase } from '../../../platform/supabase/client.ts';

export type PermState = 'tauri' | 'unsupported' | 'granted' | 'denied' | 'default';

export interface PermEnv {
  readonly win?: object;
  readonly permission?: () => NotificationPermission | null;
}

export function permState(env: PermEnv = {}): PermState {
  if (isTauri(env.win ?? globalThis)) return 'tauri';
  const p = (env.permission ?? notificationPermission)();
  return p === null ? 'unsupported' : p;
}

/** 顶部要不要出提示：被占着、要重新打开、不支持；没有为 null */
export type PushNotice =
  | { readonly kind: 'in_use'; readonly holder: EndpointHolder; readonly self: boolean }
  | { readonly kind: 'resubscribe' }
  | { readonly kind: 'not_supported' };

export function pushNoticeOf(o: EnsurePushOutcome | null, localInstallId: string | null): PushNotice | null {
  if (!o) return null;
  if (o.result === 'endpoint_in_use' && o.holder) {
    return { kind: 'in_use', holder: o.holder, self: localInstallId !== null && o.holder.install_id === localInstallId };
  }
  if (o.result === 'resubscribe_failed') return { kind: 'resubscribe' };
  if (o.result === 'not_supported') return { kind: 'not_supported' };
  return null;
}

/** 本机的 install_id（只读，不生成新的；读不到为 null） */
export function localInstallId(storage?: Pick<Storage, 'getItem'>): string | null {
  try {
    const v = (storage ?? localStorage).getItem(INSTALL_ID_KEY);
    return v ? v.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** 订阅并认领一次（必须在点按里或权限已经 granted 时调）：和启动认领同一份参数（账号锁、设备登记，platform/push-claim-run.ts）；
 *  结果写进 push-status 给顶部提示用 */
export async function claimNow(): Promise<EnsurePushOutcome> {
  return runPushClaim();
}

/** 点“打开通知”：在点按里请求权限，给了就订阅认领；返回新的权限状态 */
export async function enableNotifications(env: { request?: () => Promise<NotificationPermission>; claim?: () => Promise<EnsurePushOutcome> } = {}): Promise<NotificationPermission> {
  const request = env.request ?? requestNotificationPermission;
  let p: NotificationPermission;
  try {
    p = await request();
  } catch {
    return 'default';
  }
  if (p === 'granted') await (env.claim ?? claimNow)();
  return p;
}

export type RemoveHolderResult = 'ok' | 'reclaim_failed' | 'failed' | 'offline';

/** 点“移除它”：remove_device，成功后自动再认领一次 */
export async function removeHolder(
  holderId: string,
  deps: { remove?: (id: string) => Promise<'ok' | 'failed' | 'offline'>; claim?: () => Promise<EnsurePushOutcome> } = {},
): Promise<RemoveHolderResult> {
  const r = await (deps.remove ?? removeDeviceRpc)(holderId);
  if (r !== 'ok') return r;
  const o = await (deps.claim ?? claimNow)();
  return o.result === 'claimed' || o.result === 'already' ? 'ok' : 'reclaim_failed';
}

type LooseRpc = { rpc(fn: 'remove_device', args: { p_device_id: string }): PromiseLike<{ error: unknown }> };

async function removeDeviceRpc(id: string): Promise<'ok' | 'failed' | 'offline'> {
  try {
    const db = await getSupabase();
    const { error } = await (db as unknown as LooseRpc).rpc('remove_device', { p_device_id: id });
    if (!error) return 'ok';
    const msg = typeof error === 'object' && error !== null ? String((error as { message?: unknown }).message ?? '') : '';
    return /fetch|network/i.test(msg) ? 'offline' : 'failed';
  } catch {
    return 'offline';
  }
}
