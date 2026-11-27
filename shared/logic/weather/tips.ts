// 天气胶囊后半句的那一条提示（负责人 11-26 原话：“只提示一条”“不和合句”“语言要简洁……4个字左右”）
// • 按 WX_TIP_ORDER 的先后取第一条满足的；都不满足是“温度适宜”（mild），所以后半句总有一条
// • 门槛全在 WX_RULES 一张表里，界面和测试都只认这张表
// • “剩下时段”= 地点当地的现在这个整点到今天 24 点（含现在这个整点）；“过去 12 小时”= 现在这个整点之前的 12 个整点
// • “现在”从参数传入（epoch ms），地点当地时间按包里的 UTC 偏移算，不看手机时区
// 纯函数：不碰 Date.now、不碰 DOM
import { pad2 } from '../../core/date.ts';
import { itemAt } from '../../core/item-at.ts';
import type { WxDay, WxHour, WxPack } from '../../schema/weather.ts';

/** 门槛表（负责人 11-26 定） */
export const WX_RULES = {
  /** 下雨：任一小时降水概率 ≥ 50% */
  rainPct: 50,
  /** 路面结冰：过去这么多小时里有降水 */
  iceLookbackH: 12,
  /** 路面结冰：剩下时段最低气温 ≤ 0°C */
  iceTempC: 0,
  /** 大风：最大阵风 ≥ 50 km/h */
  gustKmh: 50,
  /** 大雾：能见度 < 1000 m */
  fogVisM: 1000,
  /** 空气差（韩国标准“나쁨”）：pm2_5 ≥ 36 µg/m³ 或 pm10 ≥ 81 µg/m³ */
  pm25Bad: 36,
  pm10Bad: 81,
  /** 降温：今天最高比昨天最高低 ≥ 5°C */
  dropC: 5,
  /** 冷：剩下时段最低体感 < 5°C */
  coldFeelC: 5,
  /** 热：剩下时段最高体感 ≥ 30°C */
  hotFeelC: 30,
  /** 早晚温差：今天最高与最低差 ≥ 10°C */
  swingC: 10,
  /** 晴：今天紫外线最大 ≥ 3 */
  sunUv: 3,
} as const;

/** 雷暴、大雾、下雪、晴（WMO 天气代码） */
export const STORM_CODES: ReadonlySet<number> = new Set([95, 96, 99]);
export const FOG_CODES: ReadonlySet<number> = new Set([45, 48]);
export const SNOW_CODES: ReadonlySet<number> = new Set([71, 73, 75, 77, 85, 86]);
export const CLEAR_CODES: ReadonlySet<number> = new Set([0, 1]);

/** 提示的种类，先后就是优先级（负责人 11-26 的 1～13） */
export const WX_TIP_ORDER = ['storm', 'rain', 'snow', 'ice', 'wind', 'fog', 'air', 'drop', 'cold', 'hot', 'swing', 'sun', 'mild'] as const;
export type WxTipKind = (typeof WX_TIP_ORDER)[number];
/** rain、snow 带整点（地点当地时间 0～23） */
export type WxTip = { kind: Exclude<WxTipKind, 'rain' | 'snow'> } | { kind: 'rain' | 'snow'; hour: number };

/** 地点当地的现在：日期 "YYYY-MM-DD"、整点键 "YYYY-MM-DDTHH:00"、钟点 */
export function localNow(pack: Pick<WxPack, 'off'>, nowMs: number): { date: string; key: string; hour: number } {
  const d = new Date(nowMs + pack.off * 1000);
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const hour = d.getUTCHours();
  return { date, key: `${date}T${pad2(hour)}:00`, hour };
}

/** 现在这个整点在 hours 里的下标；包里没有（太旧、太新）为 -1 */
export function nowIndex(pack: WxPack, nowMs: number): number {
  const { key } = localNow(pack, nowMs);
  return pack.hours.findIndex((h) => h.at === key);
}

/** 剩下时段：现在这个整点到今天 24 点 */
export function restOfToday(pack: WxPack, nowMs: number): WxHour[] {
  const i = nowIndex(pack, nowMs);
  if (i < 0) return [];
  const { date } = localNow(pack, nowMs);
  const out: WxHour[] = [];
  for (let j = i; j < pack.hours.length; j++) {
    const h = pack.hours[j];
    if (!h || h.at.slice(0, 10) !== date) break;
    out.push(h);
  }
  return out;
}

/** 从现在这个整点起往后 n 个整点（可以跨到明天；半屏逐时用） */
export function nextHours(pack: WxPack, nowMs: number, n: number): WxHour[] {
  const i = nowIndex(pack, nowMs);
  return i < 0 ? [] : pack.hours.slice(i, i + n);
}

/** 今天、昨天的逐日（地点当地） */
export function dayOf(pack: WxPack, nowMs: number, back = 0): WxDay | undefined {
  const { date } = localNow(pack, nowMs);
  const i = pack.days.findIndex((d) => d.date === date);
  return i - back >= 0 && i >= 0 ? itemAt(pack.days, i - back) : undefined;
}

/** 今天之后的 n 天（半屏“未来 7 天”，负责人 11-26） */
export function daysAfterToday(pack: WxPack, nowMs: number, n = 7): WxDay[] {
  const { date } = localNow(pack, nowMs);
  return pack.days.filter((d) => d.date > date).slice(0, n);
}

/** 这个包能不能给“今天”用：包里有现在这个整点、也有今天的逐日 */
export function packCoversNow(pack: WxPack, nowMs: number): boolean {
  return nowIndex(pack, nowMs) >= 0 && dayOf(pack, nowMs) !== undefined;
}

const hourNum = (h: WxHour): number => Number(h.at.slice(11, 13));
const isSnow = (h: WxHour): boolean => h.s > 0 || SNOW_CODES.has(h.c);

/** 空气差不差（韩国标准“나쁨”起）：就是半屏的空气等级到“差”，和 airLevel 同一处取整、同一套门槛（35.6 两边都算 36） */
export const airBad = (h: Pick<WxHour, 'pm25' | 'pm10'>): boolean => airLevel(h) >= 2;

/**
 * 每条提示“这个整点算不算”：判断提示和半屏标整点共用这一份（降温、温差、温度适宜说的是一整天，没有）
 * • 雷雨、大风、大雾、空气差、冷、热：剩下时段里有一个整点算就出；雨、雪：取第一个算的整点
 * • 路滑：气温 ≤ 0°C 的整点（另要过去 12 小时有降水）；防晒：晴的白天整点（另要占多数、紫外线够）
 */
const HOUR_HIT = new Map<WxTipKind, (h: WxHour) => boolean>([
  ['storm', (h) => STORM_CODES.has(h.c)],
  ['rain', (h) => h.p >= WX_RULES.rainPct && !isSnow(h)],
  ['snow', isSnow],
  ['ice', (h) => h.t <= WX_RULES.iceTempC],
  ['wind', (h) => h.g >= WX_RULES.gustKmh],
  ['fog', (h) => FOG_CODES.has(h.c) || h.v < WX_RULES.fogVisM],
  ['air', airBad],
  ['cold', (h) => h.f < WX_RULES.coldFeelC],
  ['hot', (h) => h.f >= WX_RULES.hotFeelC],
  ['sun', (h) => h.d === 1 && CLEAR_CODES.has(h.c)],
]);
const hits = (kind: WxTipKind, hours: readonly WxHour[]): WxHour[] => {
  const f = HOUR_HIT.get(kind);
  return f ? hours.filter(f) : [];
};

/** 每一种提示的判断：满足时回提示，不满足回 null。顺序在 WX_TIP_ORDER */
type Ctx = { rest: WxHour[]; past: WxHour[]; today: WxDay; yesterday: WxDay | undefined };
const any = (kind: Exclude<WxTipKind, 'rain' | 'snow'>) => ({ rest }: Ctx): WxTip | null => (hits(kind, rest).length > 0 ? { kind } : null);
const first = (kind: 'rain' | 'snow') => ({ rest }: Ctx): WxTip | null => {
  const h = hits(kind, rest)[0];
  return h ? { kind, hour: hourNum(h) } : null;
};
const CHECKS: Record<Exclude<WxTipKind, 'mild'>, (c: Ctx) => WxTip | null> = {
  storm: any('storm'),
  rain: first('rain'),
  snow: first('snow'),
  ice: (c) => (c.past.some((h) => h.r > 0) ? any('ice')(c) : null),
  wind: any('wind'),
  fog: any('fog'),
  air: any('air'),
  drop: ({ today, yesterday }) => (yesterday && yesterday.hi - today.hi >= WX_RULES.dropC ? { kind: 'drop' } : null),
  cold: any('cold'),
  hot: any('hot'),
  swing: ({ today }) => (today.hi - today.lo >= WX_RULES.swingC ? { kind: 'swing' } : null),
  sun: ({ rest, today }) => {
    const day = rest.filter((h) => h.d === 1).length;
    return day > 0 && hits('sun', rest).length * 2 > day && Math.round(today.uv) >= WX_RULES.sunUv ? { kind: 'sun' } : null;
  },
};

/** 胶囊后半句的那一条；包盖不住“现在”（太旧）时 null（不出胶囊） */
export function weatherTip(pack: WxPack, nowMs: number): WxTip | null {
  const rest = restOfToday(pack, nowMs);
  const today = dayOf(pack, nowMs);
  if (!rest.length || !today) return null;
  const i = nowIndex(pack, nowMs);
  const ctx: Ctx = { rest, past: pack.hours.slice(Math.max(0, i - WX_RULES.iceLookbackH), i), today, yesterday: dayOf(pack, nowMs, 1) };
  for (const kind of WX_TIP_ORDER) {
    if (kind === 'mild') break;
    const hit = CHECKS[kind](ctx);
    if (hit) return hit;
  }
  return { kind: 'mild' };
}

/**
 * 半屏逐时里要标出来的整点（负责人 11-26：胶囊正在显示的那条提示，在逐时里把对应时段标出来）：只在剩下时段里找
 * • 雨、雪：从提示的那个整点起，满足同一条件的各个整点；雷雨、大风、大雾、空气差：满足条件的整点
 * • 路滑：气温 ≤ 0°C 的整点；冷：体感 < 5°C 的；热：体感 ≥ 30°C 的；防晒：晴的白天整点
 * • 降温、温差、温度适宜：说的是一整天，不标
 */
export function tipHours(pack: WxPack, nowMs: number, tip: WxTip): ReadonlySet<string> {
  return new Set(hits(tip.kind, restOfToday(pack, nowMs)).map((h) => h.at));
}

/** 图标用的天空种类（WMO 天气代码 + 白天黑夜）。
 *  pct：这一小时、这一天的降水概率；到“几点有雨”同一门槛（WX_RULES.rainPct）时，晴、多云、雾一律画成雨，
 *  不出现“写着有雨、图标是太阳”；雷雨、雪照旧按代码 */
export type WxSky = 'clear' | 'clearNight' | 'partly' | 'partlyNight' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm';
export function skyOf(code: number, day: 0 | 1, pct = 0): WxSky {
  if (STORM_CODES.has(code)) return 'storm';
  if (SNOW_CODES.has(code)) return 'snow';
  if (pct >= WX_RULES.rainPct) return 'rain';
  if (FOG_CODES.has(code)) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if (code === 3) return 'cloudy';
  if (code === 2) return day ? 'partly' : 'partlyNight';
  return day ? 'clear' : 'clearNight';
}

/** 紫外线等级：0 低（0～2）、1 中等（3～5）、2 高（6～7）、3 很高（8～10）、4 极高（11+） */
export function uvLevel(uv: number): 0 | 1 | 2 | 3 | 4 {
  const u = Math.round(uv);
  return u >= 11 ? 4 : u >= 8 ? 3 : u >= 6 ? 2 : u >= 3 ? 1 : 0;
}

/** 空气等级（韩国标准，pm2_5 和 pm10 取差的那个）：0 好、1 普通、2 差（就是“戴好口罩”的门槛 WX_RULES）、3 很差 */
type AirSteps = { fair: number; bad: number; worse: number };
const PM25_LV: AirSteps = { fair: 16, bad: WX_RULES.pm25Bad, worse: 76 };
const PM10_LV: AirSteps = { fair: 31, bad: WX_RULES.pm10Bad, worse: 151 };
const lvOf = (v: number | null, lv: AirSteps): 0 | 1 | 2 | 3 => {
  if (v === null) return 0;
  const n = Math.round(v);
  return n >= lv.worse ? 3 : n >= lv.bad ? 2 : n >= lv.fair ? 1 : 0;
};
export function airLevel(h: Pick<WxHour, 'pm25' | 'pm10'>): 0 | 1 | 2 | 3 {
  return Math.max(lvOf(h.pm25, PM25_LV), lvOf(h.pm10, PM10_LV)) as 0 | 1 | 2 | 3;
}

/** 剩下时段里空气最差的那个整点（半屏“空气”一行；和胶囊“戴好口罩”看同一段、同一套门槛）；一个空气数都没有为 null */
export type WxAir = { level: 0 | 1 | 2 | 3; pm25: number | null; pm10: number | null };
export function airWorst(rest: readonly WxHour[]): WxAir | null {
  let worst: WxAir | null = null;
  for (const h of rest) {
    if (h.pm25 === null && h.pm10 === null) continue;
    const level = airLevel(h);
    if (!worst || level > worst.level) worst = { level, pm25: h.pm25, pm10: h.pm10 };
  }
  return worst;
}
