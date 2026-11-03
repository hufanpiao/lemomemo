// 本机算提醒、显示浮动时刻用的时区（架构 4.6）：
// • currentTz()：profiles.current_tz（服务器按“手机优先、防抖”采纳的那个，冷启动时缓存在 meta 的 profile 里）；
//   没有缓存、或不是有效的 IANA 名（旧数据、坏数据）时退回本机的时区
// • deviceTz()：本机的时区（固定时刻的日程记录时写进 events.tz，4.6“记录时设备的时区”）
// 纯 TS：不准 import React 和任何功能（A1）
import { isValidTz, type Tz } from '../../shared/core/tz.ts';
import { getBoot } from './boot.ts';

const FALLBACK_TZ: Tz = 'Asia/Seoul';

/** 本机的时区；读不到或无效时用首尔（和 tz_mode = fixed 同一个默认） */
export function deviceTz(): Tz {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && isValidTz(tz) ? tz : FALLBACK_TZ;
  } catch {
    return FALLBACK_TZ;
  }
}

/** 浮动时刻按哪个时区算（current_tz → 本机） */
export function currentTz(profile: Readonly<Record<string, unknown>> | null | undefined = getBoot()?.profile): Tz {
  const tz = profile?.['current_tz'];
  return typeof tz === 'string' && isValidTz(tz) ? tz : deviceTz();
}
