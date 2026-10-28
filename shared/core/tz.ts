// 时区工具：只用 Intl.DateTimeFormat，不依赖运行环境的本地时区（架构 2.1、4.6，ADR-012）
// 纯 TS：前端（Vite）和 Edge Functions（Deno）共用，不准用 DOM、Node、Deno 的 API

/** IANA 时区名，例如 'Asia/Seoul'。类型上只是 string 的别名，提醒调用方传时区而不是偏移量 */
export type Tz = string;

/** 某个时刻在某时区的墙上时间 */
export interface WallTime {
  y: number;
  m: number; // 1–12
  d: number;
  hh: number; // 0–23
  mm: number;
  ss: number;
}

const fmtCache = new Map<Tz, Intl.DateTimeFormat>();

function formatter(tz: Tz): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    // hourCycle h23：午夜是 0 点，不是 24 点
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** 时区名是否有效（无效时 Intl 会抛 RangeError） */
export function isValidTz(tz: string): boolean {
  if (tz === '') return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** 时刻 ms 在时区 tz 的墙上时间 */
export function wallTime(ms: number, tz: Tz): WallTime {
  const parts = formatter(tz).formatToParts(ms);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new Error(`tz_parts_missing:${type}`);
    return Number(p.value);
  };
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour'), mm: get('minute'), ss: get('second') };
}

/** 时刻 ms 时，时区 tz 比 UTC 快多少分钟（首尔 +540，洛杉矶夏令时 -420） */
export function offsetMin(ms: number, tz: Tz): number {
  const w = wallTime(ms, tz);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss);
  // 去掉毫秒和秒的零头再比
  const base = Math.floor(ms / 1000) * 1000;
  return Math.round((asUtc - base) / 60000);
}
