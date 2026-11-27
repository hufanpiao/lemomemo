// 天气精简包（shared/logic/weather/pack.ts）：粗坐标、查询串坐标只认一种写法、上游两份收成一包、城市搜索只留有人住的地方
import { describe, expect, it } from 'vitest';
import { coarse, coordText, HOUR_DAYS, packForecast, packPlaces, parseCoord } from '../../../shared/logic/weather/pack.ts';
import { upstreamForecastSchema, wxPackSchema, type UpstreamForecast } from '../../../shared/schema/weather.ts';

function upstream(): UpstreamForecast {
  const dates = ['2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03'];
  const time = dates.flatMap((d) => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, '0')}:00`));
  const n = time.length;
  const fill = <T>(v: T): T[] => Array.from({ length: n }, () => v);
  return upstreamForecastSchema.parse({
    utc_offset_seconds: 32400,
    current: { temperature_2m: 3.2, apparent_temperature: null, weather_code: 3, is_day: 1 },
    hourly: {
      time,
      temperature_2m: time.map((_, i) => (i === 5 ? null : 4)),
      apparent_temperature: fill(1),
      precipitation_probability: fill(null),
      precipitation: fill(0),
      snowfall: fill(0),
      weather_code: fill(3),
      uv_index: fill(0.5),
      is_day: fill(1),
      wind_gusts_10m: fill(null),
      visibility: fill(null),
    },
    daily: {
      time: dates,
      temperature_2m_max: dates.map(() => 7),
      temperature_2m_min: dates.map((_, i) => (i === 8 ? null : -2)),
      uv_index_max: dates.map(() => 2),
      precipitation_probability_max: dates.map(() => 10),
      weather_code: dates.map(() => 3),
    },
  });
}

describe('粗坐标', () => {
  it('保留 1 位小数、-0 写成 0、超范围 null', () => {
    expect(coarse(37.5665, 90)).toBe(37.6);
    expect(coarse(-0.04, 90)).toBe(0);
    expect(Object.is(coarse(-0.04, 90), -0)).toBe(false);
    expect(coarse(91, 90)).toBeNull();
    expect(coarse(Number.NaN, 90)).toBeNull();
    expect(coordText(127)).toBe('127.0');
  });
  it('查询串只认 1 位小数以内的写法（缓存键只有一种）', () => {
    expect(parseCoord('37.6', 90)).toBe(37.6);
    expect(parseCoord('-12', 180)).toBe(-12);
    for (const bad of ['37.56', '37.', '1e2', ' 37.6', '91', '', null]) expect(parseCoord(bad, 90)).toBeNull();
  });
});

describe('上游收成精简包', () => {
  it('逐时只留前三天；气温 null 的整点丢掉；体感 null 用气温；阵风、能见度 null 补“没有”', () => {
    const p = packForecast(upstream(), null);
    expect(wxPackSchema.parse(p)).toEqual(p);
    expect(p.hours).toHaveLength(HOUR_DAYS * 24 - 1);
    expect(p.hours.some((h) => h.at === '2026-11-25T05:00')).toBe(false);
    expect(p.hours.at(-1)?.at).toBe('2026-11-27T23:00');
    const h = p.hours[0];
    expect(h).toMatchObject({ t: 4, f: 1, p: 0, g: 0, v: 99_999, pm25: null, pm10: null });
    expect(p.cur).toEqual({ t: 3.2, f: 3.2, c: 3, d: 1 });
    expect(p.off).toBe(32400);
    expect(p.air).toBe(false);
  });
  it('逐日最高最低缺一个的那天丢掉；昨天 + 今天 + 7 天都在', () => {
    const p = packForecast(upstream(), null);
    expect(p.days.map((d) => d.date)).toEqual(['2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
  });
  it('空气质量按整点对上；对不上的整点为 null', () => {
    const p = packForecast(upstream(), { hourly: { time: ['2026-11-26T09:00', '2026-11-26T10:00'], pm2_5: [41, null], pm10: [60, 90] } });
    expect(p.air).toBe(true);
    expect(p.hours.find((h) => h.at === '2026-11-26T09:00')).toMatchObject({ pm25: 41, pm10: 60 });
    expect(p.hours.find((h) => h.at === '2026-11-26T10:00')).toMatchObject({ pm25: null, pm10: 90 });
    expect(p.hours.find((h) => h.at === '2026-11-26T11:00')).toMatchObject({ pm25: null, pm10: null });
  });
});

describe('城市搜索', () => {
  it('只留 PPL 开头的地方、人多的在前、最多 8 个、粗坐标、同名同坐标去重、副标题是省 · 国家', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `城${i}`, latitude: 30 + i, longitude: 120, feature_code: 'PPL', population: i }));
    const out = packPlaces({
      results: [
        { name: '首尔特别市', latitude: 37.566, longitude: 126.978, feature_code: 'PPLC', population: 10_000_000, admin1: '首尔特别市', country: '韩国' },
        { name: '首尔特别市', latitude: 37.57, longitude: 126.98, feature_code: 'PPLA', population: 9_000_000, country: '韩国' },
        { name: '汉江', latitude: 37.5, longitude: 127, feature_code: 'STM', population: 0 },
        ...many,
      ],
    });
    expect(out).toHaveLength(8);
    expect(out[0]).toEqual({ name: '首尔特别市', sub: '韩国', lat: 37.6, lon: 127 });
    expect(out.filter((p) => p.name === '首尔特别市')).toHaveLength(1);
    expect(out.some((p) => p.name === '汉江')).toBe(false);
    expect(out[1]?.name).toBe('城11');
  });
  it('没结果时上游连 results 都没有', () => {
    expect(packPlaces({})).toEqual([]);
  });
});
