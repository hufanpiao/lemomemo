// 天气：粗坐标、上游 Open-Meteo 回包收成 App 用的精简包（functions/wx 用；纯函数，前端测试也直接测）
// • 粗坐标：一律保留 1 位小数（约 10 公里），请求上游、缓存键、本机存的都是它；不进日志、不存服务器
// • 精简包：逐时、逐日按下标对齐；上游某个小时气温是 null 的整点丢掉；其余 null 按“没有”补 0（能见度补很大，阵风补 0）
// • 空气质量另一份接口，按整点 at 对上；取不到时各小时 pm25、pm10 为 null，pack.air 为 false
import { itemAt } from '../../core/item-at.ts';
import type { UpstreamAir, UpstreamForecast, UpstreamGeo, WxDay, WxHour, WxPack, WxPlace } from '../../schema/weather.ts';

/** 粗坐标：保留 1 位小数；超出范围、不是数时 null */
export function coarse(n: number, max: number): number | null {
  if (!Number.isFinite(n) || Math.abs(n) > max) return null;
  const r = Math.round(n * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}

/** 查询串里的坐标：必须正好是 1 位小数以内的写法（"37.6"、"-0.5"、"127"），别的一律不认（缓存键只有一种写法） */
const COORD_RE = /^-?\d{1,3}(\.\d)?$/;
export function parseCoord(raw: string | null, max: number): number | null {
  if (raw === null || !COORD_RE.test(raw)) return null;
  const n = Number(raw);
  return Math.abs(n) <= max ? n : null;
}

/** 坐标写进查询串：固定 1 位小数 */
export const coordText = (n: number): string => n.toFixed(1);

/** 逐时留几天（从逐日的第一天、即昨天算） */
export const HOUR_DAYS = 3;

/** 没有能见度数据时当成很远（不触发“大雾”） */
const FAR_M = 99_999;

/** 上游没给天气代码时当阴天（3）：当成晴（0）会误出“做好防晒”、画晴天图标 */
const NO_CODE = 3;
const n0 = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 上游两份（air 取不到传 null）收成精简包 */
export function packForecast(fc: UpstreamForecast, air: UpstreamAir | null): WxPack {
  const h = fc.hourly;
  const airAt = new Map<string, { pm25: number | null; pm10: number | null }>();
  if (air) {
    air.hourly.time.forEach((at, i) => airAt.set(at, { pm25: itemAt(air.hourly.pm2_5, i) ?? null, pm10: itemAt(air.hourly.pm10, i) ?? null }));
  }
  const hours: WxHour[] = [];
  // 逐时只留逐日的前三天（昨天、今天、明天）：未来 7 天只看逐日，包和本机缓存不白带六天的逐时
  const hourDays = new Set(fc.daily.time.slice(0, HOUR_DAYS));
  h.time.forEach((at, i) => {
    const t = itemAt(h.temperature_2m, i);
    if (typeof t !== 'number' || !/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(at) || !hourDays.has(at.slice(0, 10))) return;
    const f = itemAt(h.apparent_temperature, i);
    const v = itemAt(h.visibility, i);
    const a = airAt.get(at);
    hours.push({
      at,
      t,
      f: typeof f === 'number' ? f : t,
      p: n0(itemAt(h.precipitation_probability, i)),
      r: n0(itemAt(h.precipitation, i)),
      s: n0(itemAt(h.snowfall, i)),
      c: itemAt(h.weather_code, i) ?? NO_CODE,
      uv: n0(itemAt(h.uv_index, i)),
      d: itemAt(h.is_day, i) === 1 ? 1 : 0,
      g: n0(itemAt(h.wind_gusts_10m, i)),
      v: typeof v === 'number' ? v : FAR_M,
      pm25: a?.pm25 ?? null,
      pm10: a?.pm10 ?? null,
    });
  });
  const days: WxDay[] = [];
  fc.daily.time.forEach((date, i) => {
    const hi = itemAt(fc.daily.temperature_2m_max, i);
    const lo = itemAt(fc.daily.temperature_2m_min, i);
    if (typeof hi !== 'number' || typeof lo !== 'number' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    days.push({ date, hi, lo, uv: n0(itemAt(fc.daily.uv_index_max, i)), p: n0(itemAt(fc.daily.precipitation_probability_max, i)), c: itemAt(fc.daily.weather_code, i) ?? NO_CODE });
  });
  const cur = fc.current;
  return {
    v: 1,
    off: fc.utc_offset_seconds,
    cur: { t: cur.temperature_2m, f: cur.apparent_temperature ?? cur.temperature_2m, c: cur.weather_code, d: cur.is_day === 1 ? 1 : 0 },
    days,
    hours,
    air: air !== null,
  };
}

/** 城市搜索：只留有人住的地方（feature_code 以 PPL 开头），人多的在前，最多 8 个；坐标收成粗坐标，同一粗坐标同名的只留一个 */
export function packPlaces(geo: UpstreamGeo): WxPlace[] {
  const seen = new Set<string>();
  const out: WxPlace[] = [];
  const rows = (geo.results ?? []).filter((r) => !r.feature_code || r.feature_code.startsWith('PPL'));
  rows.sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
  for (const r of rows) {
    const lat = coarse(r.latitude, 90);
    const lon = coarse(r.longitude, 180);
    if (lat === null || lon === null) continue;
    const key = `${r.name}|${lat}|${lon}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sub = [r.admin1, r.country].filter((s): s is string => !!s && s !== r.name).join(' · ');
    out.push({ name: r.name.slice(0, 80), sub: sub.slice(0, 120), lat, lon });
    if (out.length >= 8) break;
  }
  return out;
}
