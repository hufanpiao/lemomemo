// 本机设备行要用到的本机信息和锁
// • 本会话的 session_id 在 platform/session.ts（读会话键只有那一份）
// • readInstallId：这一份安装的随机 id，存在 lemo.install_id；退出登录、被移除、换账号都不清。读不到 localStorage 时返回 null
// • devicePlatform：iPhone、iPad 上的网页记 ios（report_tz 的“手机优先”按 platform = 'ios' 认手机）；Tauri 窗口记 tauri；其余 web。windows 现在不用
// • withLock：登记设备行时跨标签页互斥（navigator.locks）；没有 locks 时直接跑（core/device-reg.ts 另有兜底）
import { isUuid } from '../../shared/core/uuid.ts';
import { isAppleMobile, isTauri, type NavLike } from './env.ts';
import type { LocksLike } from './tab-leader.ts';

export const INSTALL_ID_KEY = 'lemo.install_id';

export type DevicePlatform = 'ios' | 'windows' | 'web' | 'tauri';

/** 这一份安装的 install_id：有就读，没有就生成一个存下；存不了（隐私模式）返回 null */
export function readInstallId(storage?: Storage, gen: () => string = () => crypto.randomUUID()): string | null {
  try {
    const s = storage ?? localStorage;
    const v = s.getItem(INSTALL_ID_KEY);
    if (isUuid(v, true)) return v.toLowerCase();
    const id = gen();
    s.setItem(INSTALL_ID_KEY, id);
    return s.getItem(INSTALL_ID_KEY) === id ? id : null;   // 写进去又读不出来（配额、隐私模式）：不用
  } catch {
    return null;
  }
}

/** devices.platform：Tauri 窗口 tauri；iPhone、iPad 上的任何浏览器 ios；其余 web */
export function devicePlatform(nav: NavLike = navigator, win: object = globalThis): DevicePlatform {
  if (isTauri(win)) return 'tauri';   // 判断只在 env.ts 一处
  return isAppleMobile(nav) ? 'ios' : 'web';
}

function defaultLocks(): LocksLike | null {
  const n = typeof navigator !== 'undefined' ? (navigator as { locks?: LocksLike }).locks : undefined;
  return n && typeof n.request === 'function' ? n : null;
}

/** 拿到名为 name 的排他锁后跑 fn，返回 fn 的结果；没有 navigator.locks 时直接跑 */
export async function withLock<T>(name: string, fn: () => Promise<T>, locks: LocksLike | null = defaultLocks()): Promise<T> {
  if (!locks) return fn();
  let out: { v: T } | null = null;
  await locks.request(name, { mode: 'exclusive' }, async () => {
    out = { v: await fn() };
  });
  if (!out) throw new Error('lock_no_result');
  return (out as { v: T }).v;
}
