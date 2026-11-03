// exe 里本机会话删不掉以后的两件事（安全审查 A-1、代码审查 A-M1；从 session.ts 分出来，它回到 300 行以内）：
// • retryDropSession：“退出没完成，点重试”上的重试（app/ExitIncompleteScreen.tsx）
// • settleDropAtStartup：启动时带着“待删除”标记就先删（main 入口，installDesktopSession 之后、读会话之前）
// 标记、删除轮次和状态在 session-store.ts；网页版没有这一层
import { isTauri } from './env.ts';
import { clearAnyLocalSession } from './session.ts';
import { clearDropMark, hasDropMark } from './session-store.ts';
import { reloadPage } from './sw-register.ts';

/**
 * “退出没完成”上的“重试”（A-1）：再删一次本机会话（clearAnyLocalSession，不管是谁的——用户就是要退出），删成了撤掉标记、整页重新载入。
 * 返回删没删成。不抛错
 */
export async function retryDropSession(reload: () => void = reloadPage): Promise<boolean> {
  const ok = await clearAnyLocalSession();
  if (!ok) return false;
  clearDropMark();
  reload();
  return true;
}

/**
 * exe 启动时（installDesktopSession 之后、读会话之前）：带着“待删除”标记就先删本机会话（A-1）。删成了（或本来就没有标记）返回 true；
 * 删不掉返回 false，调用方不画账号界面、只给“退出没完成，点重试”。网页版直接 true
 */
export async function settleDropAtStartup(): Promise<boolean> {
  if (!isTauri() || !hasDropMark()) return true;
  const ok = await clearAnyLocalSession();
  if (ok) clearDropMark();
  return ok;
}
