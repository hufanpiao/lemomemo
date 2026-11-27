// 天气的两个请求：经同源的 /wx/v1/*（functions/wx 代理 Open-Meteo，浏览器不直接连第三方）
// • forecast：粗坐标（1 位小数）进，WxPack 出；城市搜索：搜索词进，粗坐标的城市出。回包一律先过 zod（shared/schema/weather.ts）
// • 地址和数据接口同一个来源（exe 里也是 lemomemo.com，跨域走 CORS，同 files.ts 的 filesBaseFrom）；不带令牌、不带自定义头（简单请求，不预检）
// • 运行日志只记“取天气成功 / 失败（原因）、耗时”，不记坐标、城市名、搜索词（负责人 11-26 定）
// 纯 TS：不准 import React
import { wxPackSchema, wxPlacesSchema, type WxPack, type WxPlace } from '../../shared/schema/weather.ts';
import { coordText } from '../../shared/logic/weather/pack.ts';
import { buildInfo, isAbortErr } from './env.ts';
import { rlog } from './run-log-api.ts';

/** 等多久算超时 */
export const WX_TIMEOUT_MS = 10_000;

export type WxFail = 'offline' | 'timeout' | 'http' | 'bad_body';
export type WxResult<T> = { ok: true; value: T } | { ok: false; why: WxFail };

/** /wx/v1/ 的绝对地址：有数据接口地址时跟它，没有（本机、e2e）用本页来源 */
export function wxBase(supabaseUrl: string = buildInfo.supabaseUrl, fallbackOrigin: string = typeof location !== 'undefined' ? location.origin : 'http://localhost'): string {
  return new URL('/wx/v1/', supabaseUrl || fallbackOrigin).toString();
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

async function getParsed<T>(path: string, parse: (raw: unknown) => T | null, tag: string, now: () => number, f: Fetch): Promise<WxResult<T>> {
  const t0 = now();
  const done = (r: WxResult<T>): WxResult<T> => {
    rlog(`wx ${tag} ${r.ok ? 'ok' : `fail why=${r.why}`} ms=${Math.round(now() - t0)}`);
    return r;
  };
  let res: Response;
  try {
    res = await f(new URL(path, wxBase()).toString(), { signal: AbortSignal.timeout(WX_TIMEOUT_MS), credentials: 'omit' });
  } catch (e) {
    return done({ ok: false, why: isAbortErr(e) ? 'timeout' : 'offline' });
  }
  if (!res.ok) return done({ ok: false, why: 'http' });
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return done({ ok: false, why: 'bad_body' });
  }
  const value = parse(raw);
  return done(value === null ? { ok: false, why: 'bad_body' } : { ok: true, value });
}

const fetchImpl: Fetch = (u, i) => fetch(u, i);

/** 这个粗坐标的天气 */
export function fetchWeather(lat: number, lon: number, now: () => number, f: Fetch = fetchImpl): Promise<WxResult<WxPack>> {
  const q = new URLSearchParams({ lat: coordText(lat), lon: coordText(lon) });
  return getParsed(
    `forecast?${q.toString()}`,
    (raw) => {
      const r = wxPackSchema.safeParse(raw);
      return r.success ? r.data : null;
    },
    'forecast',
    now,
    f,
  );
}

/** 城市搜索（lang：界面语言 zh / ko，城市名按这种语言回） */
export function searchPlaces(q: string, lang: 'zh' | 'ko', now: () => number, f: Fetch = fetchImpl): Promise<WxResult<readonly WxPlace[]>> {
  return getParsed(
    `geo?${new URLSearchParams({ q, lang }).toString()}`,
    (raw) => {
      const r = wxPlacesSchema.safeParse(raw);
      return r.success ? r.data.places : null;
    },
    'geo',
    now,
    f,
  );
}
