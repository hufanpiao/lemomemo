// 天气测试用的假精简包：昨天、今天、明天三天逐时（UTC 偏移默认 0），逐日 9 天（昨天起）；
// 默认什么提示都不触发（阴天 15°C、没雨、风小、空气好、温差 6°C），各用例只改要测的那几个整点
import { addDays, pad2 as pad } from '../../../shared/core/date.ts';
import type { WxDay, WxHour, WxPack } from '../../../shared/schema/weather.ts';

export const TODAY = '2026-11-26';
/** 今天当地 09:00（偏移 0 时就是 UTC 09:00） */
export const NOW = Date.parse(`${TODAY}T09:00:00Z`);

export function hour(at: string, patch: Partial<WxHour> = {}): WxHour {
  const hh = Number(at.slice(11, 13));
  return { at, t: 15, f: 15, p: 0, r: 0, s: 0, c: 3, uv: 1, d: hh >= 7 && hh < 18 ? 1 : 0, g: 10, v: 20_000, pm25: 10, pm10: 20, ...patch };
}

export function day(date: string, patch: Partial<WxDay> = {}): WxDay {
  return { date, hi: 18, lo: 12, uv: 2, p: 0, c: 3, ...patch };
}

export function makePack(opts: { off?: number; hour?: (h: WxHour) => Partial<WxHour>; days?: Record<string, Partial<WxDay>> } = {}): WxPack {
  const hours: WxHour[] = [];
  for (let d = -1; d <= 1; d++) {
    const date = addDays(TODAY, d);
    for (let h = 0; h < 24; h++) {
      const base = hour(`${date}T${pad(h)}:00`);
      hours.push({ ...base, ...(opts.hour?.(base) ?? {}) });
    }
  }
  const days: WxDay[] = [];
  for (let d = -1; d < 8; d++) {
    const date = addDays(TODAY, d);
    days.push(day(date, opts.days?.[date] ?? {}));
  }
  return { v: 1, off: opts.off ?? 0, cur: { t: 15, f: 15, c: 3, d: 1 }, days, hours, air: true };
}

/** 今天的某个整点（"HH"） */
export const isToday = (h: WxHour, hh: number): boolean => h.at === `${TODAY}T${pad(hh)}:00`;
export const YESTERDAY = addDays(TODAY, -1);
export const TOMORROW = addDays(TODAY, 1);
