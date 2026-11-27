// `/wx/v1/*` 天气代理（functions/wx/[[path]].ts，负责人 11-26）：路径和参数、来源检查、缓存命中、空气质量取不到照样回、上游失败 502、日志不带坐标
// 上游用桩：按地址回假的 Open-Meteo 回包，不连真接口（真接口的字段 11-26 手动核过一次）
import { describe, expect, it, vi } from 'vitest';
import { airUrl, forecastUrl, GEO_OWN_ONLY_TTL_S, geoUrl, handleWx, parseWxRoute, sourceAllowed, WX_NO_AIR_TTL_S, WX_TTL_S, type WxCache, type WxDeps } from '../../functions/wx/[[path]].ts';
import { EXE_ORIGIN } from '../../functions/_lib/cors.ts';
import { wxPackSchema, wxPlacesSchema } from '../../shared/schema/weather.ts';

const SITE = 'https://lemomemo.com';

function forecastBody() {
  const dates = ['2026-11-25', '2026-11-26', '2026-11-27'];
  const time = dates.flatMap((d) => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, '0')}:00`));
  const fill = (v: number | null) => time.map(() => v);
  return {
    utc_offset_seconds: 32400,
    current: { temperature_2m: 3, apparent_temperature: 1, weather_code: 0, is_day: 1 },
    hourly: {
      time,
      temperature_2m: fill(3),
      apparent_temperature: fill(1),
      precipitation_probability: fill(0),
      precipitation: fill(0),
      snowfall: fill(0),
      weather_code: fill(0),
      uv_index: fill(1),
      is_day: fill(1),
      wind_gusts_10m: fill(10),
      visibility: fill(20000),
    },
    daily: {
      time: dates,
      temperature_2m_max: [7, 7, 7],
      temperature_2m_min: [-2, -2, -2],
      uv_index_max: [2, 2, 2],
      precipitation_probability_max: [0, 0, 0],
      weather_code: [0, 0, 0],
    },
  };
}
const airBody = { hourly: { time: ['2026-11-26T09:00'], pm2_5: [40], pm10: [50] } };
const geoBody = { results: [{ name: '서울특별시', latitude: 37.566, longitude: 126.978, feature_code: 'PPLC', population: 10_000_000, country: '대한민국' }] };

/** 内存缓存（同 caches.default 的 match / put） */
function memCache(): WxCache & { size(): number; ages: string[] } {
  const m = new Map<string, string>();
  const ages: string[] = [];
  return {
    match: async (k) => (m.has(k.url) ? new Response(m.get(k.url)) : undefined),
    put: async (k, r) => {
      ages.push(r.headers.get('Cache-Control') ?? '');
      m.set(k.url, await r.text());
    },
    size: () => m.size,
    ages,
  };
}

function setup(opts: { air?: 'ok' | 'fail' | 'bad'; forecast?: 'ok' | 'fail' | 'bad'; geo?: 'ok' | 'fail'; cache?: WxCache | null } = {}) {
  const calls: string[] = [];
  const logs: Array<{ evt: string; hit: boolean }> = [];
  const fetchFn = vi.fn(async (url: string): Promise<Response> => {
    calls.push(url);
    const u = new URL(url);
    if (u.hostname === 'api.open-meteo.com') {
      if (opts.forecast === 'fail') return new Response('x', { status: 500 });
      return Response.json(opts.forecast === 'bad' ? { nope: 1 } : forecastBody());
    }
    if (u.hostname === 'air-quality-api.open-meteo.com') {
      if (opts.air === 'fail') throw new Error('net');
      return Response.json(opts.air === 'bad' ? { hourly: 1 } : airBody);
    }
    if (opts.geo === 'fail') return new Response('x', { status: 503 });
    return Response.json(geoBody);
  });
  const deps: WxDeps = { fetch: fetchFn, cache: opts.cache === undefined ? memCache() : opts.cache, now: () => 0, log: (evt, _ms, hit) => logs.push({ evt, hit }) };
  return { deps, calls, logs };
}

const get = (path: string, headers: Record<string, string> = { 'Sec-Fetch-Site': 'same-origin' }, method = 'GET') => new Request(`${SITE}${path}`, { method, headers });

describe('路径和参数', () => {
  it('forecast 的坐标只认 1 位小数以内；geo 要 q 和 zh/ko', () => {
    expect(parseWxRoute(new URL(`${SITE}/wx/v1/forecast?lat=37.6&lon=127.0`))).toEqual({ kind: 'forecast', lat: 37.6, lon: 127 });
    expect(parseWxRoute(new URL(`${SITE}/wx/v1/forecast?lat=37.5665&lon=127`))).toEqual({ kind: 'bad' });
    expect(parseWxRoute(new URL(`${SITE}/wx/v1/forecast?lat=91&lon=127`))).toEqual({ kind: 'bad' });
    expect(parseWxRoute(new URL(`${SITE}/wx/v1/geo?q=%20Seoul%20&lang=ko`))).toEqual({ kind: 'geo', q: 'Seoul', lang: 'ko' });
    expect(parseWxRoute(new URL(`${SITE}/wx/v1/geo?q=Seoul&lang=en`))).toEqual({ kind: 'bad' });
    expect(parseWxRoute(new URL(`${SITE}/wx/v1/geo?q=${'가'.repeat(41)}&lang=ko`))).toEqual({ kind: 'bad' });
    expect(parseWxRoute(new URL(`${SITE}/wx/v1/other`))).toBeNull();
  });
  it('上游地址：粗坐标固定写法、past_days=1、forecast_days=8、timezone=auto', () => {
    const u = new URL(forecastUrl(37.6, 127));
    expect(u.searchParams.get('latitude')).toBe('37.6');
    expect(u.searchParams.get('longitude')).toBe('127.0');
    expect(u.searchParams.get('past_days')).toBe('1');
    expect(u.searchParams.get('forecast_days')).toBe('8');
    expect(u.searchParams.get('timezone')).toBe('auto');
    expect(new URL(airUrl(37.6, 127)).searchParams.get('hourly')).toBe('pm2_5,pm10');
    expect(new URL(geoUrl('首尔', 'zh')).searchParams.get('language')).toBe('zh');
  });
  it('400 / 404 / 405 / 预检 204', async () => {
    const { deps, calls } = setup();
    expect((await handleWx(get('/wx/v1/forecast?lat=a&lon=1'), deps)).status).toBe(400);
    expect((await handleWx(get('/wx/v1/nope'), deps)).status).toBe(404);
    const post = await handleWx(get('/wx/v1/forecast?lat=1&lon=1', {}, 'POST'), deps);
    expect(post.status).toBe(405);
    expect(post.headers.get('Allow')).toBe('GET, OPTIONS');
    expect((await handleWx(get('/wx/v1/forecast', {}, 'OPTIONS'), deps)).status).toBe(204);
    expect(calls).toHaveLength(0);
  });
});

describe('来源检查', () => {
  it('同站、直接打开、exe 放；别的站点 403，不去上游', async () => {
    expect(sourceAllowed(get('/wx/v1/forecast', { 'Sec-Fetch-Site': 'same-origin' }))).toBe(true);
    expect(sourceAllowed(get('/wx/v1/forecast', { 'Sec-Fetch-Site': 'none' }))).toBe(true);
    expect(sourceAllowed(get('/wx/v1/forecast', { Origin: EXE_ORIGIN, 'Sec-Fetch-Site': 'cross-site' }))).toBe(true);
    expect(sourceAllowed(get('/wx/v1/forecast', {}))).toBe(true);
    expect(sourceAllowed(get('/wx/v1/forecast', { Origin: SITE }))).toBe(true);
    expect(sourceAllowed(get('/wx/v1/forecast', { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' }))).toBe(false);
    expect(sourceAllowed(get('/wx/v1/forecast', { Origin: 'https://evil.example' }))).toBe(false);
    const { deps, calls, logs } = setup();
    const r = await handleWx(get('/wx/v1/forecast?lat=37.6&lon=127.0', { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' }), deps);
    expect(r.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(logs).toEqual([{ evt: 'wx_forbidden', hit: false }]);
  });
});

describe('天气', () => {
  it('回精简包（过 zod）；同一粗坐标第二次命中缓存、不再去上游', async () => {
    const { deps, calls, logs } = setup();
    const r1 = await handleWx(get('/wx/v1/forecast?lat=37.6&lon=127.0'), deps);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('Cache-Control')).toBe('no-store');
    const pack = wxPackSchema.parse(await r1.json());
    expect(pack.air).toBe(true);
    expect(pack.hours.find((h) => h.at === '2026-11-26T09:00')?.pm25).toBe(40);
    expect(calls).toHaveLength(2);
    const r2 = await handleWx(get('/wx/v1/forecast?lat=37.6&lon=127'), deps);
    expect(await r2.json()).toEqual(pack);
    expect(calls).toHaveLength(2);
    expect(logs.map((l) => `${l.evt}:${l.hit}`)).toEqual(['wx_forecast_ok:false', 'wx_forecast_ok:true']);
  });
  it('缓存 30 分钟', () => {
    expect(WX_TTL_S).toBe(1800);
  });
  it('空气质量取不到或格式不对：天气照样回，air=false', async () => {
    for (const air of ['fail', 'bad'] as const) {
      const { deps } = setup({ air });
      const r = await handleWx(get('/wx/v1/forecast?lat=37.6&lon=127.0'), deps);
      expect(r.status).toBe(200);
      const pack = wxPackSchema.parse(await r.json());
      expect(pack.air).toBe(false);
      expect(pack.hours.every((h) => h.pm25 === null)).toBe(true);
    }
  });
  it('空气取到时缓存 30 分钟，没取到时只缓存 5 分钟；写缓存交给 waitUntil，不拖慢这一次', async () => {
    for (const air of ['ok', 'fail'] as const) {
      const cache = memCache();
      const deferred: Promise<unknown>[] = [];
      const { deps } = setup({ air, cache });
      deps.defer = (p) => void deferred.push(p);
      expect((await handleWx(get('/wx/v1/forecast?lat=37.6&lon=127.0'), deps)).status).toBe(200);
      expect(deferred).toHaveLength(1);
      await Promise.all(deferred);
      expect(cache.ages).toEqual([`public, max-age=${air === 'ok' ? WX_TTL_S : WX_NO_AIR_TTL_S}`]);
    }
  });
  it('天气上游出错或格式不对：502，不写缓存', async () => {
    for (const forecast of ['fail', 'bad'] as const) {
      const cache = memCache();
      const { deps, logs } = setup({ forecast, cache });
      const r = await handleWx(get('/wx/v1/forecast?lat=37.6&lon=127.0'), deps);
      expect(r.status).toBe(502);
      expect(await r.json()).toEqual({ code: 'upstream_failed' });
      expect(cache.size()).toBe(0);
      expect(logs.at(-1)?.evt).toBe('wx_forecast_upstream_failed');
    }
  });
  it('没有缓存可用时照样能取', async () => {
    const { deps } = setup({ cache: null });
    expect((await handleWx(get('/wx/v1/forecast?lat=37.6&lon=127.0'), deps)).status).toBe(200);
  });
  it('日志只有事件名、耗时、是否命中，不带坐标', async () => {
    const spy = vi.fn();
    const { deps } = setup();
    deps.log = spy;
    await handleWx(get('/wx/v1/forecast?lat=37.6&lon=127.0'), deps);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/37\.6|127/);
  });
});

describe('城市搜索', () => {
  it('不在内置表里的：回 Open-Meteo 的城市，坐标是粗坐标', async () => {
    const { deps } = setup();
    const r = await handleWx(get(`/wx/v1/geo?q=${encodeURIComponent('강진')}&lang=ko`), deps);
    expect(r.status).toBe(200);
    expect(wxPlacesSchema.parse(await r.json())).toEqual({ places: [{ name: '서울특별시', sub: '대한민국', lat: 37.6, lon: 127 }] });
  });

  it('内置常用城市排最前，带 key；Open-Meteo 里同一处（不到 0.3°）不再列', async () => {
    const { deps } = setup();
    const r = await handleWx(get(`/wx/v1/geo?q=${encodeURIComponent('서울')}&lang=ko`), deps);
    expect(wxPlacesSchema.parse(await r.json())).toEqual({ places: [{ key: 'seoul', name: '서울', sub: '대한민국', lat: 37.6, lon: 127 }] });
  });

  it('Open-Meteo 取不到：内置表有就只回内置的（只缓存 5 分钟），没有才 502', async () => {
    const cache = memCache();
    const { deps } = setup({ geo: 'fail', cache });
    const r = await handleWx(get(`/wx/v1/geo?q=${encodeURIComponent('东京')}&lang=zh`), deps);
    expect(r.status).toBe(200);
    expect(wxPlacesSchema.parse(await r.json()).places.map((p) => p.key)).toEqual(['tokyo']);
    expect(cache.ages).toEqual([`public, max-age=${GEO_OWN_ONLY_TTL_S}`]);
    const r2 = await handleWx(get(`/wx/v1/geo?q=${encodeURIComponent('강진')}&lang=ko`), deps);
    expect(r2.status).toBe(502);
  });
});
