// 天气胶囊后半句（shared/logic/weather/tips.ts，负责人 11-26 的 13 条）：每条各一次、同时满足多条只取最靠前的、半屏要标的整点、未来 7 天
import { describe, expect, it } from 'vitest';
import {
  airLevel,
  airWorst,
  daysAfterToday,
  nextHours,
  packCoversNow,
  restOfToday,
  skyOf,
  tipHours,
  uvLevel,
  weatherTip,
  WX_RULES,
  WX_TIP_ORDER,
} from '../../../shared/logic/weather/tips.ts';
import { isToday, makePack, NOW, TODAY, TOMORROW, YESTERDAY } from './wx-fixture.ts';

const at = (hh: number): string => `${TODAY}T${String(hh).padStart(2, '0')}:00`;

describe('13 条提示各一次', () => {
  it('1 雷暴：剩下时段有 95/96/99', () => {
    for (const c of [95, 96, 99]) expect(weatherTip(makePack({ hour: (h) => (isToday(h, 16) ? { c } : {}) }), NOW)).toEqual({ kind: 'storm' });
  });
  it('2 下雨：第一个降水概率 ≥50% 的整点', () => {
    const p = makePack({ hour: (h) => (isToday(h, 15) ? { p: 50 } : isToday(h, 18) ? { p: 90 } : {}) });
    expect(weatherTip(p, NOW)).toEqual({ kind: 'rain', hour: 15 });
  });
  it('3 下雪：snowfall > 0 或代码 71–77/85/86（概率再高也算雪、不算雨）', () => {
    expect(weatherTip(makePack({ hour: (h) => (isToday(h, 14) ? { s: 0.4, p: 80 } : {}) }), NOW)).toEqual({ kind: 'snow', hour: 14 });
    for (const c of [71, 73, 75, 77, 85, 86]) expect(weatherTip(makePack({ hour: (h) => (isToday(h, 20) ? { c } : {}) }), NOW)).toEqual({ kind: 'snow', hour: 20 });
  });
  it('4 路面结冰：过去 12 小时有降水，剩下时段最低气温 ≤0°C', () => {
    const p = makePack({ hour: (h) => (isToday(h, 2) ? { r: 0.6 } : isToday(h, 23) ? { t: 0 } : {}) });
    expect(weatherTip(p, NOW)).toEqual({ kind: 'ice' });
  });
  it('5 大风：最大阵风 ≥50 km/h', () => {
    expect(weatherTip(makePack({ hour: (h) => (isToday(h, 12) ? { g: 50 } : {}) }), NOW)).toEqual({ kind: 'wind' });
  });
  it('6 大雾：代码 45/48 或能见度 <1000 m', () => {
    expect(weatherTip(makePack({ hour: (h) => (isToday(h, 10) ? { c: 45 } : {}) }), NOW)).toEqual({ kind: 'fog' });
    expect(weatherTip(makePack({ hour: (h) => (isToday(h, 10) ? { c: 48 } : {}) }), NOW)).toEqual({ kind: 'fog' });
    expect(weatherTip(makePack({ hour: (h) => (isToday(h, 10) ? { v: 999 } : {}) }), NOW)).toEqual({ kind: 'fog' });
  });
  it('7 空气差：pm2_5 ≥36 或 pm10 ≥81', () => {
    expect(weatherTip(makePack({ hour: (h) => (isToday(h, 11) ? { pm25: 36 } : {}) }), NOW)).toEqual({ kind: 'air' });
    expect(weatherTip(makePack({ hour: (h) => (isToday(h, 11) ? { pm10: 81 } : {}) }), NOW)).toEqual({ kind: 'air' });
    // 和半屏 airLevel 同一处取整（独立评审 11-26：35.6 半屏写“差 / 36”，胶囊却不出“戴好口罩”）
    expect(weatherTip(makePack({ hour: (h) => (isToday(h, 11) ? { pm25: 35.6 } : {}) }), NOW)).toEqual({ kind: 'air' });
    expect(airLevel({ pm25: 35.6, pm10: null })).toBe(2);
    expect(weatherTip(makePack({ hour: (h) => (isToday(h, 11) ? { pm25: 35.4 } : {}) }), NOW)).toEqual({ kind: 'mild' });
  });
  it('8 降温：今天最高比昨天低 ≥5°C', () => {
    expect(weatherTip(makePack({ days: { [YESTERDAY]: { hi: 23 } } }), NOW)).toEqual({ kind: 'drop' });
  });
  it('9 冷：最低体感 <5°C', () => {
    expect(weatherTip(makePack({ hour: (h) => (isToday(h, 22) ? { f: 4.9 } : {}) }), NOW)).toEqual({ kind: 'cold' });
  });
  it('10 热：最高体感 ≥30°C', () => {
    expect(weatherTip(makePack({ hour: (h) => (isToday(h, 14) ? { f: 30 } : {}) }), NOW)).toEqual({ kind: 'hot' });
  });
  it('11 早晚温差：今天最高与最低差 ≥10°C', () => {
    expect(weatherTip(makePack({ days: { [TODAY]: { hi: 21, lo: 11 } } }), NOW)).toEqual({ kind: 'swing' });
  });
  it('12 晴：剩下白天以 0/1 为主且今天紫外线最大 ≥3', () => {
    const sunny = (h: { d: 0 | 1 }) => (h.d === 1 ? { c: 1 } : {});
    expect(weatherTip(makePack({ hour: sunny, days: { [TODAY]: { uv: 3 } } }), NOW)).toEqual({ kind: 'sun' });
    // 紫外线不够：不提防晒。和半屏 uvLevel 同样先取整（独立评审 11-26：2.6 半屏写“中等”、胶囊却不提防晒）
    expect(weatherTip(makePack({ hour: sunny, days: { [TODAY]: { uv: 2.4 } } }), NOW)).toEqual({ kind: 'mild' });
    expect(weatherTip(makePack({ hour: sunny, days: { [TODAY]: { uv: 2.6 } } }), NOW)).toEqual({ kind: 'sun' });
    expect(uvLevel(2.6)).toBe(1);
    // 晴的不到一半：不算以晴为主
    const half = makePack({ hour: (h) => (h.d === 1 && Number(h.at.slice(11, 13)) % 2 === 0 ? { c: 0 } : {}), days: { [TODAY]: { uv: 6 } } });
    expect(weatherTip(half, NOW)).toEqual({ kind: 'mild' });
  });
  it('13 都不满足：温度适宜', () => {
    expect(weatherTip(makePack(), NOW)).toEqual({ kind: 'mild' });
  });
  it('门槛差一点都不触发（门槛只在 WX_RULES 一张表里）', () => {
    const p = makePack({
      hour: (h) => ({ p: WX_RULES.rainPct - 1, g: WX_RULES.gustKmh - 1, v: WX_RULES.fogVisM, pm25: WX_RULES.pm25Bad - 1, pm10: WX_RULES.pm10Bad - 1, f: h.d ? WX_RULES.hotFeelC - 1 : WX_RULES.coldFeelC }),
      days: { [YESTERDAY]: { hi: 18 + WX_RULES.dropC - 1 }, [TODAY]: { hi: 18, lo: 18 - WX_RULES.swingC + 1 } },
    });
    expect(weatherTip(p, NOW)).toEqual({ kind: 'mild' });
  });
  it('顺序表正好 13 条、最后一条是温度适宜', () => {
    expect(WX_TIP_ORDER).toHaveLength(13);
    expect(WX_TIP_ORDER.at(-1)).toBe('mild');
  });
});

describe('同时满足多条只取最靠前的一条', () => {
  it('雷暴 + 下雨 → 雷暴', () => {
    expect(weatherTip(makePack({ hour: (h) => (isToday(h, 15) ? { c: 95, p: 90 } : {}) }), NOW)).toEqual({ kind: 'storm' });
  });
  it('下雨 + 冷 → 下雨', () => {
    expect(weatherTip(makePack({ hour: (h) => (isToday(h, 15) ? { p: 70, f: 1 } : {}) }), NOW)).toEqual({ kind: 'rain', hour: 15 });
  });
  it('结冰 + 冷 → 小心路滑', () => {
    const p = makePack({ hour: (h) => (isToday(h, 5) ? { r: 1 } : isToday(h, 21) ? { t: -2, f: -6 } : {}) });
    expect(weatherTip(p, NOW)).toEqual({ kind: 'ice' });
  });
  it('没下过雨的零下 → 不是路滑，是冷', () => {
    expect(weatherTip(makePack({ hour: (h) => (isToday(h, 21) ? { t: -2, f: -6 } : {}) }), NOW)).toEqual({ kind: 'cold' });
  });
  it('空气差 + 降温 → 空气差；降温 + 温差 → 降温', () => {
    expect(weatherTip(makePack({ hour: (h) => (isToday(h, 11) ? { pm25: 50 } : {}), days: { [YESTERDAY]: { hi: 30 } } }), NOW)).toEqual({ kind: 'air' });
    expect(weatherTip(makePack({ days: { [YESTERDAY]: { hi: 30 }, [TODAY]: { hi: 22, lo: 8 } } }), NOW)).toEqual({ kind: 'drop' });
  });
  it('热 + 晴 → 热；温差 + 晴 → 温差', () => {
    const sunny = (h: { d: 0 | 1 }) => (h.d === 1 ? { c: 0 } : {});
    expect(weatherTip(makePack({ hour: (h) => ({ ...sunny(h), ...(isToday(h, 14) ? { f: 33 } : {}) }), days: { [TODAY]: { uv: 8 } } }), NOW)).toEqual({ kind: 'hot' });
    expect(weatherTip(makePack({ hour: sunny, days: { [TODAY]: { uv: 8, hi: 24, lo: 9 } } }), NOW)).toEqual({ kind: 'swing' });
  });
});

describe('剩下时段 = 现在这个整点到今天 24 点', () => {
  it('现在以前的雨、明天的雨都不算', () => {
    const p = makePack({ hour: (h) => (isToday(h, 8) || h.at.startsWith(TOMORROW) ? { p: 100 } : {}) });
    expect(weatherTip(p, NOW)).toEqual({ kind: 'mild' });
    expect(restOfToday(p, NOW).map((h) => h.at)).toEqual(Array.from({ length: 15 }, (_, i) => at(9 + i)));
  });
  it('现在这个整点本身算', () => {
    expect(weatherTip(makePack({ hour: (h) => (isToday(h, 9) ? { p: 60 } : {}) }), NOW + 59 * 60_000)).toEqual({ kind: 'rain', hour: 9 });
  });
  it('按地点的 UTC 偏移算当地时间（首尔 +9：UTC 00:00 是当地 09:00）', () => {
    const seoul = makePack({ off: 9 * 3600, hour: (h) => (isToday(h, 9) ? { p: 70 } : {}) });
    expect(weatherTip(seoul, Date.parse(`${TODAY}T00:00:00Z`))).toEqual({ kind: 'rain', hour: 9 });
  });
  it('包太旧（盖不住现在）→ null，不出胶囊', () => {
    const p = makePack();
    expect(weatherTip(p, NOW + 3 * 86_400_000)).toBeNull();
    expect(packCoversNow(p, NOW + 3 * 86_400_000)).toBe(false);
    expect(packCoversNow(p, NOW)).toBe(true);
  });
});

describe('半屏：要标出的整点、逐时、未来 7 天', () => {
  it('下雨标出剩下时段里每个降水概率 ≥50% 的整点', () => {
    const p = makePack({ hour: (h) => (isToday(h, 15) || isToday(h, 16) ? { p: 60 } : isToday(h, 7) ? { p: 90 } : {}) });
    const tip = weatherTip(p, NOW);
    expect(tip).toEqual({ kind: 'rain', hour: 15 });
    expect([...tipHours(p, NOW, tip ?? { kind: 'mild' })]).toEqual([at(15), at(16)]);
  });
  it('冷标体感 <5°C 的整点；降温、温差、温度适宜不标', () => {
    const p = makePack({ hour: (h) => (isToday(h, 22) || isToday(h, 23) ? { f: 2 } : {}) });
    expect([...tipHours(p, NOW, { kind: 'cold' })]).toEqual([at(22), at(23)]);
    for (const kind of ['drop', 'swing', 'mild'] as const) expect(tipHours(p, NOW, { kind }).size).toBe(0);
  });
  it('逐时从现在这个整点起，可以跨到明天', () => {
    const hs = nextHours(makePack(), Date.parse(`${TODAY}T20:30:00Z`), 6);
    expect(hs.map((h) => h.at)).toEqual([at(20), at(21), at(22), at(23), `${TOMORROW}T00:00`, `${TOMORROW}T01:00`]);
  });
  it('未来 7 天从明天起、正好 7 天（forecast_days=8 含今天）', () => {
    const week = daysAfterToday(makePack(), NOW);
    expect(week).toHaveLength(7);
    expect(week[0]?.date).toBe(TOMORROW);
    expect(week.every((d) => d.date > TODAY)).toBe(true);
  });
});

describe('图标和等级', () => {
  it('天空种类', () => {
    expect([skyOf(0, 1), skyOf(1, 0), skyOf(2, 1), skyOf(2, 0), skyOf(3, 1), skyOf(45, 1), skyOf(61, 1), skyOf(81, 0), skyOf(73, 1), skyOf(95, 1)]).toEqual([
      'clear', 'clearNight', 'partly', 'partlyNight', 'cloudy', 'fog', 'rain', 'rain', 'snow', 'storm',
    ]);
  });
  it('降水概率到“几点有雨”的门槛就画成雨：不出现写着有雨、图标是太阳（负责人 11-27 选“概率≥50%改成雨的图标”）', () => {
    const p = WX_RULES.rainPct;
    expect([skyOf(0, 1, p), skyOf(1, 0, p), skyOf(2, 1, 67), skyOf(3, 1, p), skyOf(45, 1, p)]).toEqual(['rain', 'rain', 'rain', 'rain', 'rain']);
    // 门槛以下照旧；雷雨、雪照旧按代码
    expect([skyOf(0, 1, p - 1), skyOf(95, 1, 90), skyOf(73, 1, 90)]).toEqual(['clear', 'storm', 'snow']);
  });
  it('紫外线、空气等级的分界', () => {
    expect([2.4, 3, 5, 6, 7, 8, 10, 11].map(uvLevel)).toEqual([0, 1, 1, 2, 2, 3, 3, 4]);
    expect([15, 16, 35, 36, 75, 76].map((pm25) => airLevel({ pm25, pm10: null }))).toEqual([0, 1, 1, 2, 2, 3]);
    expect([30, 31, 80, 81, 150, 151].map((pm10) => airLevel({ pm25: null, pm10 }))).toEqual([0, 1, 1, 2, 2, 3]);
    expect(airLevel({ pm25: 10, pm10: 90 })).toBe(2); // 取差的那个
  });
  it('半屏的空气看剩下时段最差的整点，和“戴好口罩”同一个门槛；没有空气数据为 null', () => {
    const pack = makePack({ hour: (h) => (isToday(h, 16) ? { pm25: 10, pm10: 90 } : {}) });
    const rest = restOfToday(pack, NOW);
    expect(airWorst(rest)).toEqual({ level: 2, pm25: 10, pm10: 90 });
    expect(weatherTip(pack, NOW)).toEqual({ kind: 'air' });
    expect(airWorst(rest.map((h) => ({ ...h, pm25: null, pm10: null })))).toBeNull();
  });
});
