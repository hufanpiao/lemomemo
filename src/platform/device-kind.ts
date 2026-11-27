// 设备类型：按设备类型分开记的设置用（如 notes.view@mobile / @desktop）。
// 单独一个文件、只被懒加载块引：不进首屏（放 env.ts 或 setting-read.ts 会让首屏变大）。纯 TS
import { isAppleMobile, isTauri } from './env.ts';

// 电脑版 exe 算电脑；iPhone、iPad（含伪装成 Mac 的 iPadOS）算手机；其余看主指针：粗指针（触屏）算手机，鼠标、触控板算电脑
export type DeviceKind = 'mobile' | 'desktop';

export function deviceKindOf(d: { tauri: boolean; appleMobile: boolean; coarse: boolean }): DeviceKind {
  if (d.tauri) return 'desktop';
  return d.appleMobile || d.coarse ? 'mobile' : 'desktop';
}

function coarsePointer(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** 这台设备算手机还是电脑（同一台设备不会变，打开页面时判断一次就够） */
export function thisDeviceKind(): DeviceKind {
  return deviceKindOf({ tauri: isTauri(), appleMobile: isAppleMobile(), coarse: coarsePointer() });
}

/** 按设备类型分开记的键：perDeviceKey('notes.view', 'mobile') = 'notes.view@mobile' */
export const perDeviceKey = (base: string, kind: DeviceKind): string => `${base}@${kind}`;
