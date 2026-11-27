// 本机推送认领记录的键和删除：push.ts 退出时才按需下载，但含账号信息的认领记录退出时不能留，下载失败也得删。
// 这里不 import 任何东西：首屏、SW 都能带。也放退出断开共用的上限和“要不要退订”的判断（push.ts、push-disconnect.ts 同一套）
/** 本机记“已认领 / 不支持”的键（push-claim.ts 写；值只有摘要，见那边的文件头） */
export const CLAIM_STORAGE_KEY = 'lemo.push.claimed';

/** 删掉本机的认领记录（退出、被移除、换账号都经 disconnectBrowserPush / push-disconnect.ts 走到这里）；不抛 */
export function forgetPushClaim(storage?: () => Storage | null): void {
  try {
    (storage ? storage() : globalThis.localStorage)?.removeItem(CLAIM_STORAGE_KEY);
  } catch {
    // 读不了 localStorage：没有可删的
  }
}

/**
 * 退出时断开浏览器推送最多等多久（失败、超时都不能卡住退出）。
 * 放这里：push-disconnect.ts 要给“下载 push.ts + 断开”整体用同一个上限，又不能静态引 push.ts
 */
export const DISCONNECT_PUSH_MS = 2000;

/**
 * 退出时读通知权限：没有 Notification 返回 null。
 * 不复用 defaultPermission：那个在没有 Notification 时返回 'default'，会把“拿不准”当成“可以不退订”
 */
export const strictPermission = (): NotificationPermission | null => (typeof Notification !== 'undefined' ? Notification.permission : null);

/** 只有权限明确是 denied / default 才跳过退订；null（没有 Notification）、别的值、读取抛错都照常退订 */
export function skipUnsubscribe(read: () => NotificationPermission | null): boolean {
  try {
    const p = read();
    return p === 'denied' || p === 'default';
  } catch {
    return false;
  }
}
