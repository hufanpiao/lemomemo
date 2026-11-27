// 天气的“自动定位”：问浏览器要一次位置，只留粗坐标（1 位小数，约 10 公里）
// • 不在打开 App 时问（负责人 11-26 定）：只有用户在 设置 › 天气 里点“用当前位置”时才弹框问（“设置城市看天气”只是带人去那里）
// • 读权限状态用 Permissions API；iOS 上它不可靠（同意后 24 小时内照样回 'prompt'，拒绝后也可能回 'prompt'，WebKit bug 275479），
//   所以只在明确回 'granted' 时才会不经点按自己去取位置；别的情况用上次记下的粗坐标，没有就等用户点
// • 精度要求低（enableHighAccuracy: false），30 分钟内的旧位置也收（maximumAge），10 秒超时
// 纯 TS：不准 import React
import { coarse } from '../../shared/logic/weather/pack.ts';
import { errName } from './env.ts';
import { rlog } from './run-log-api.ts';

export type GeoPerm = 'granted' | 'denied' | 'prompt' | 'unsupported';
export type GeoFail = 'denied' | 'unavailable' | 'timeout' | 'unsupported';
export type GeoResult = { ok: true; lat: number; lon: number } | { ok: false; why: GeoFail };

export const GEO_TIMEOUT_MS = 10_000;
export const GEO_MAX_AGE_MS = 30 * 60_000;

const geo = (): Geolocation | null => (typeof navigator !== 'undefined' && navigator.geolocation ? navigator.geolocation : null);

/** 定位权限现在的状态；问不到（没有 Permissions API、不认 'geolocation'）时：有定位接口回 'prompt'，没有回 'unsupported' */
export async function geoPermission(): Promise<GeoPerm> {
  if (!geo()) return 'unsupported';
  try {
    const s = await navigator.permissions.query({ name: 'geolocation' });
    return s.state;
  } catch {
    return 'prompt';
  }
}

/** 取一次位置（会弹系统询问框）；拿到的坐标当场收成粗坐标 */
export function locate(): Promise<GeoResult> {
  const g = geo();
  if (!g) return Promise.resolve({ ok: false, why: 'unsupported' });
  return new Promise((resolve) => {
    try {
      g.getCurrentPosition(
        (p) => {
          const lat = coarse(p.coords.latitude, 90);
          const lon = coarse(p.coords.longitude, 180);
          rlog(`geo locate ok=${lat !== null && lon !== null ? 1 : 0}`);
          resolve(lat === null || lon === null ? { ok: false, why: 'unavailable' } : { ok: true, lat, lon });
        },
        (e) => {
          const why: GeoFail = e.code === e.PERMISSION_DENIED ? 'denied' : e.code === e.TIMEOUT ? 'timeout' : 'unavailable';
          rlog(`geo locate fail why=${why}`);
          resolve({ ok: false, why });
        },
        { enableHighAccuracy: false, maximumAge: GEO_MAX_AGE_MS, timeout: GEO_TIMEOUT_MS },
      );
    } catch (e) {
      rlog(`geo locate throw ${errName(e)}`);
      resolve({ ok: false, why: 'unavailable' });
    }
  });
}
