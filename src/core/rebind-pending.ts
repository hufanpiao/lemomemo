// 交接设备行“结果不确定”期间的闸（11-14 隐私记整块评审第 5 条）：服务器可能已经吊销了旧会话 S1、新会话 S2 还在内存里没换上，
// 这时用 S1 的请求会回 session_revoked。退出流程（core/device-exit.ts 的 exitDevice）判被移除之前先来这里：
// 有没换上的 S2 就先把交接做完（core/session-rebind.ts 登记的 finish），换上了就不退出、不清库。
// 同一时刻只做一次（几处同时收到 session_revoked 共用一个结果）。纯 TS，不 import 别的模块（在首屏里，越小越好）
let rescue: (() => Promise<boolean>) | null = null;
let going: Promise<boolean> | null = null;

/** session-rebind.ts 用：结果不确定、S2 留着时登记；换上或丢掉 S2 时传 null */
export function setRebindRescue(fn: (() => Promise<boolean>) | null): void {
  rescue = fn;
}

/** 测试用：有没有登记（只读，不触发交接；正式代码不用，打包时摇掉） */
export const hasRebindRescue = (): boolean => rescue !== null;

/**
 * 退出流程用：没有待换的 S2 回 null（退出流程不用等，照原来的同步顺序走）；
 * 有就先做完交接，回 true 表示已换上新会话、不用退出
 */
export function rescueByRebind(): Promise<boolean> | null {
  if (!rescue) return null;
  going ??= rescue()
    .catch(() => false)
    .finally(() => {
      going = null;
    });
  return going;
}
