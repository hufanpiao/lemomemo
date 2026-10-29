// 本机设备行要用到的本机信息和锁（架构 0.38 第 62 条④、0.29 续第 99、109 条；接手清单 K8-tz-device）
// • 本会话的 session_id 在 platform/session.ts（readSessionId、sessionIdOfToken，读会话键只有那一份）
// • readInstallId：这一份安装的随机 id（0.29 续第 109 条），存在 localStorage 的 lemo.install_id；退出登录、被移除、换账号都不清
//   （platform/sign-out.ts 不碰它）。读不到 localStorage（隐私模式）时返回 null，设备行的 install_id 就留空
// • devicePlatform：devices.platform（ios / windows / web / tauri）。iPhone、iPad 上的网页（主屏幕版）记 ios——
//   report_tz 的“手机优先”按 platform = 'ios' 认手机（4.6）；Tauri 窗口记 tauri；其余记 web。windows 现在不用
// • withLock：登记设备行时跨标签页互斥（navigator.locks，名字 'lemo-device-reg:<user_id>'）；没有 locks 时直接跑
//   （core/device-reg.ts 另外在生成新 id 前重读一次 meta 兜底）
import { isAppleMobile, type NavLike } from './env.ts';
import type { LocksLike } from './tab-leader.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const INSTALL_ID_KEY = 'lemo.install_id';

export type DevicePlatform = 'ios' | 'windows' | 'web' | 'tauri';

/** 这一份安装的 install_id：有就读，没有就生成一个存下；存不了（隐私模式）返回 null */
export function readInstallId(storage?: Storage, gen: () => string = () => crypto.randomUUID()): string | null {
  try {
    const s = storage ?? localStorage;
    const v = s.getItem(INSTALL_ID_KEY);
    if (v && UUID_RE.test(v)) return v.toLowerCase();
    const id = gen();
    s.setItem(INSTALL_ID_KEY, id);
    return s.getItem(INSTALL_ID_KEY) === id ? id : null;   // 写进去又读不出来（配额、隐私模式）：不用
  } catch {
    return null;
  }
}

/** devices.platform：Tauri 窗口 tauri；iPhone、iPad 上的任何浏览器 ios；其余 web */
export function devicePlatform(nav: NavLike = navigator, win: object = globalThis): DevicePlatform {
  if ('__TAURI_INTERNALS__' in win || '__TAURI__' in win) return 'tauri';
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
