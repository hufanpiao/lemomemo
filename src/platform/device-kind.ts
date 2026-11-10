// 设备类型（B4 S1，R-53、R-78）：按设备类型分开记的设置用（如随手记显示方式 notes.view@mobile / @desktop，数据字典第 9 节）。
// 单独一个文件、只被随手记页和设置页（都是懒加载块）引：不进首屏（B4 首屏额度 R-379；放 env.ts 或 setting-read.ts 时实测首屏多 89 B）。纯 TS
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
