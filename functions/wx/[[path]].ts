// `/wx/v1/*`：今天页天气胶囊的代理（负责人 11-26 定 Open-Meteo，经我们自己的边缘服务转一层）
//   GET /wx/v1/forecast?lat=37.6&lon=127.0   天气（forecast，past_days=1、forecast_days=8）＋ 空气质量（air-quality）收成一个精简包（shared/logic/weather/pack.ts）
//   GET /wx/v1/geo?q=서울특별시&lang=ko        城市搜索（geocoding），回粗坐标
// • 为什么代理：浏览器不直接连第三方（第三方看不到用户 IP）；同一粗坐标 30 分钟内所有人共用一份（Cloudflare 缓存，caches.default）
// • 坐标只认 1 位小数以内的写法（parseCoord），别的回 400；缓存键只有这一种写法
// • 不要登录：天气不是用户数据。只放同站页面（Sec-Fetch-Site: same-origin，或没有这个头的老浏览器）和 exe 的来源，别的站点来的 403
// • 日志只记结果码、耗时、是否命中缓存（JSON 一行），不记 URL、查询串、坐标、城市名、请求头
// • 错误体 {code}；上游出错、超时回 502（App 按“取不到”处理：有本机缓存就显示上次的）
import { matchCities, mergePlaces } from '../../shared/logic/weather/cities.ts';
import { packForecast, packPlaces, parseCoord, coordText } from '../../shared/logic/weather/pack.ts';
import { upstreamAirSchema, upstreamForecastSchema, upstreamGeoSchema, wxPackSchema, type UpstreamAir } from '../../shared/schema/weather.ts';
import { applyCors, isAllowedOrigin, preflightHeaders } from '../_lib/cors.ts';
import { applySbSecurityHeaders } from '../_lib/security-headers.ts';

export const WX_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const WX_AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
export const WX_GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';

/** 天气缓存 30 分钟（负责人 11-26 定）；城市搜索结果一天 */
export const WX_TTL_S = 30 * 60;
export const GEO_TTL_S = 24 * 60 * 60;
/** 空气质量那一份没取到时只缓存这么久（不让 30 分钟里所有人都不判“戴好口罩”） */
export const WX_NO_AIR_TTL_S = 5 * 60;
/** 城市搜索 Open-Meteo 没取到、只回内置城市时只缓存这么久 */
export const GEO_OWN_ONLY_TTL_S = 5 * 60;
/** 城市搜索最多回几条 */
export const GEO_MAX = 8;
/** 等上游最多这么久 */
export const UPSTREAM_TIMEOUT_MS = 8000;
/** 城市搜索词最长（字符） */
export const GEO_Q_MAX = 40;

const FORECAST_HOURLY = 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,snowfall,weather_code,uv_index,is_day,wind_gusts_10m,visibility';
const FORECAST_DAILY = 'temperature_2m_max,temperature_2m_min,uv_index_max,precipitation_probability_max,weather_code';
const FORECAST_CURRENT = 'temperature_2m,apparent_temperature,weather_code,is_day';

/** 上游请求地址（坐标已是粗坐标的固定写法） */
export function forecastUrl(lat: number, lon: number): string {
  const q = new URLSearchParams({
    latitude: coordText(lat),
    longitude: coordText(lon),
    current: FORECAST_CURRENT,
    hourly: FORECAST_HOURLY,
    daily: FORECAST_DAILY,
    timezone: 'auto',
    past_days: '1',
    // 含今天 8 天：半屏列今天之后的 7 天（负责人 11-26）；同一次请求，不另发
    forecast_days: '8',
  });
  return `${WX_FORECAST_URL}?${q.toString()}`;
}

export function airUrl(lat: number, lon: number): string {
  const q = new URLSearchParams({ latitude: coordText(lat), longitude: coordText(lon), hourly: 'pm2_5,pm10', timezone: 'auto', forecast_days: '2' });
  return `${WX_AIR_URL}?${q.toString()}`;
}

export function geoUrl(q: string, lang: 'zh' | 'ko'): string {
  return `${WX_GEO_URL}?${new URLSearchParams({ name: q, count: '20', language: lang, format: 'json' }).toString()}`;
}

export interface WxCache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, res: Response): Promise<void>;
}

export interface WxDeps {
  fetch(url: string, init: RequestInit): Promise<Response>;
  cache: WxCache | null;
  now(): number;
  log(evt: string, ms: number, hit: boolean): void;
  /** 回完以后接着做的（写缓存）：Pages 里是 ctx.waitUntil；不给就当场等完 */
  defer?(p: Promise<unknown>): void;
}

type Route = { kind: 'forecast'; lat: number; lon: number } | { kind: 'geo'; q: string; lang: 'zh' | 'ko' } | { kind: 'bad' } | null;

/** 路径和参数：不认识的路径 null（404），参数不对 bad（400） */
export function parseWxRoute(url: URL): Route {
  if (url.pathname === '/wx/v1/forecast') {
    const lat = parseCoord(url.searchParams.get('lat'), 90);
    const lon = parseCoord(url.searchParams.get('lon'), 180);
    return lat === null || lon === null ? { kind: 'bad' } : { kind: 'forecast', lat, lon };
  }
  if (url.pathname === '/wx/v1/geo') {
    const q = (url.searchParams.get('q') ?? '').trim();
    const lang = url.searchParams.get('lang');
    if (!q || [...q].length > GEO_Q_MAX || (lang !== 'zh' && lang !== 'ko')) return { kind: 'bad' };
    return { kind: 'geo', q, lang };
  }
  return null;
}

/**
 * 来源放不放：exe 的 Origin 放；Sec-Fetch-Site 是 same-origin 放；没有 Sec-Fetch-Site（Safari 16.4 以前）时，
 * 没有 Origin 或 Origin 就是本站也放；别的（别的站点的页面来取）不放
 */
export function sourceAllowed(req: Request): boolean {
  const origin = req.headers.get('Origin');
  if (isAllowedOrigin(origin)) return true;
  const site = req.headers.get('Sec-Fetch-Site');
  if (site !== null) return site === 'same-origin' || site === 'none';
  return origin === null || origin === new URL(req.url).origin;
}

/** 回给 App 的 JSON（成功、出错同一套头：不缓存、/sb 同一组安全头、CORS）。不和 _lib/files-http.ts 的 json 合：那边是文件的安全头、不带 no-store */
function reply(status: number, body: string, origin: string | null, extra?: Record<string, string>): Response {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  applySbSecurityHeaders(h);
  applyCors(h, origin);
  for (const [k, v] of Object.entries(extra ?? {})) h.set(k, v);
  return new Response(body, { status, headers: h });
}
const fail = (status: number, code: string, origin: string | null, extra?: Record<string, string>): Response => reply(status, JSON.stringify({ code }), origin, extra);

async function getJson(deps: WxDeps, url: string): Promise<unknown> {
  const res = await deps.fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`upstream_${res.status}`);
  return res.json();
}

/** 缓存里的一份：键是假的固定地址（不出网），值是我们回给 App 的 JSON 字符串 */
const cacheKey = (path: string): Request => new Request(`https://wx-cache.lemomemo.invalid${path}`);

/** 先查缓存；没有就 make()（回要回的字符串和缓存多久），回完再写缓存（不拖慢这一次） */
async function cached(deps: WxDeps, path: string, make: () => Promise<{ body: string; ttl: number }>): Promise<{ body: string; hit: boolean }> {
  const key = cacheKey(path);
  const hit = deps.cache ? await deps.cache.match(key).catch(() => undefined) : undefined;
  if (hit) return { body: await hit.text(), hit: true };
  const { body, ttl } = await make();
  if (deps.cache) {
    const res = new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` } });
    const put = deps.cache.put(key, res).catch(() => undefined);
    if (deps.defer) deps.defer(put);
    else await put;
  }
  return { body, hit: false };
}

async function makeForecast(deps: WxDeps, lat: number, lon: number): Promise<{ body: string; ttl: number }> {
  // 空气质量另一份接口：取不到不耽误天气（pack.air 为 false，“戴好口罩”不判）
  const [fcRaw, airRaw] = await Promise.all([getJson(deps, forecastUrl(lat, lon)), getJson(deps, airUrl(lat, lon)).catch(() => null)]);
  const fc = upstreamForecastSchema.parse(fcRaw);
  const airParsed = airRaw === null ? null : upstreamAirSchema.safeParse(airRaw);
  const air: UpstreamAir | null = airParsed?.success ? airParsed.data : null;
  // 精简包先过一遍 App 那边同一份校验：不合格的不回、不缓存（不然 App 30 分钟里一直拒收）
  const pack = wxPackSchema.parse(packForecast(fc, air));
  return { body: JSON.stringify(pack), ttl: pack.air ? WX_TTL_S : WX_NO_AIR_TTL_S };
}

/**
 * 城市搜索：内置常用城市表先上（Open-Meteo 搜两个字的常用城市名常搜不到或排错，11-26 真请求见 cities.ts），再接 Open-Meteo 的结果；
 * Open-Meteo 取不到时，内置表有结果就只回内置的（只缓存 5 分钟），没有才算失败
 */
async function makeGeo(deps: WxDeps, q: string, lang: 'zh' | 'ko'): Promise<{ body: string; ttl: number }> {
  const own = matchCities(q, lang);
  const up = await getJson(deps, geoUrl(q, lang))
    .then((raw) => packPlaces(upstreamGeoSchema.parse(raw)))
    .catch((e: unknown) => {
      if (own.length === 0) throw e;
      return null;
    });
  return { body: JSON.stringify({ places: mergePlaces(own, up ?? [], GEO_MAX) }), ttl: up ? GEO_TTL_S : GEO_OWN_ONLY_TTL_S };
}

export async function handleWx(req: Request, deps: WxDeps): Promise<Response> {
  const origin = req.headers.get('Origin');
  const method = req.method.toUpperCase();
  if (method === 'OPTIONS') {
    const h = preflightHeaders(origin, 'GET, OPTIONS', []);
    applySbSecurityHeaders(h);
    return new Response(null, { status: 204, headers: h });
  }
  if (method !== 'GET') return fail(405, 'method_not_allowed', origin, { Allow: 'GET, OPTIONS' });
  const url = new URL(req.url);
  const route = parseWxRoute(url);
  if (route === null) return fail(404, 'not_found', origin);
  if (!sourceAllowed(req)) {
    deps.log('wx_forbidden', 0, false);
    return fail(403, 'forbidden', origin);
  }
  if (route.kind === 'bad') return fail(400, 'bad_request', origin);
  const t0 = deps.now();
  const tag = route.kind === 'forecast' ? 'wx_forecast' : 'wx_geo';
  try {
    const out =
      route.kind === 'forecast'
        ? await cached(deps, `/forecast/${coordText(route.lat)}/${coordText(route.lon)}`, () => makeForecast(deps, route.lat, route.lon))
        : await cached(deps, `/geo/${route.lang}/${encodeURIComponent(route.q.toLowerCase())}`, () => makeGeo(deps, route.q, route.lang));
    deps.log(`${tag}_ok`, deps.now() - t0, out.hit);
    return reply(200, out.body, origin);
  } catch {
    deps.log(`${tag}_upstream_failed`, deps.now() - t0, false);
    return fail(502, 'upstream_failed', origin);
  }
}

function logWx(evt: string, ms: number, hit: boolean): void {
  console.log(JSON.stringify({ evt, ms: Math.round(ms), hit }));
}

export const onRequest: PagesFunction = (ctx) => {
  // 本机 wrangler pages dev 也有 caches.default（内存里的）；拿不到时不缓存，照样能用
  let cache: WxCache | null = null;
  try {
    cache = caches.default;
  } catch {
    cache = null;
  }
  return handleWx(ctx.request, { fetch: (u, i) => fetch(u, i), cache, now: () => Date.now(), log: logWx, defer: (p) => ctx.waitUntil(p) });
};
