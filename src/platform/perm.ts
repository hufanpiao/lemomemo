// 权限状态（架构 5.9“权限状态”：platform/perm.ts）：通知用 Notification.permission
// • notificationPermission()：没有 Notification 的环境返回 null（界面写“这个浏览器不能收通知”）
// • requestNotificationPermission()：只能在用户点按里调（iOS 主屏幕版只认点按）；不支持或抛错按 'default'
// 麦克风的部分归 B3（录音）
export function notificationPermission(): NotificationPermission | null {
  return typeof Notification !== 'undefined' ? Notification.permission : null;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined' || typeof Notification.requestPermission !== 'function') return 'default';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'default';
  }
}
