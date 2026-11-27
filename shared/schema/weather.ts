// 天气（今天页天气胶囊，负责人 11-26）：上游 Open-Meteo 的回包、我们自己 /wx/v1/* 回给 App 的精简包，两边都过 zod
// • 上游三个接口：forecast（逐时、逐日、现在）、air-quality（逐时 pm2_5、pm10）、geocoding search（城市搜索）
// • 服务器（functions/wx）把上游三份收成 WxPack / WxPlaces 再给 App；App 收到也再过一遍 zod（外部来的数据一律先过 zod，架构 9.2）
// • 坐标一律粗坐标（保留 1 位小数，约 10 公里）：精简包里不回传坐标
import { z } from 'zod';

const num = z.number().finite();
const numOrNull = num.nullable();
const arr = <T extends z.ZodTypeAny>(s: T) => z.array(s);

/** forecast 接口（只认我们要的字段；多出来的字段不管） */
export const upstreamForecastSchema = z.object({
  utc_offset_seconds: z.number().int(),
  current: z.object({
    temperature_2m: num,
    apparent_temperature: numOrNull,
    weather_code: z.number().int(),
    is_day: z.number().int(),
  }),
  hourly: z.object({
    time: arr(z.string()),
    temperature_2m: arr(numOrNull),
    apparent_temperature: arr(numOrNull),
    precipitation_probability: arr(numOrNull),
    precipitation: arr(numOrNull),
    snowfall: arr(numOrNull),
    weather_code: arr(z.number().int().nullable()),
    uv_index: arr(numOrNull),
    is_day: arr(z.number().int().nullable()),
    wind_gusts_10m: arr(numOrNull),
    visibility: arr(numOrNull),
  }),
  daily: z.object({
    time: arr(z.string()),
    temperature_2m_max: arr(numOrNull),
    temperature_2m_min: arr(numOrNull),
    uv_index_max: arr(numOrNull),
    precipitation_probability_max: arr(numOrNull),
    weather_code: arr(z.number().int().nullable()),
  }),
});
export type UpstreamForecast = z.infer<typeof upstreamForecastSchema>;

/** air-quality 接口 */
export const upstreamAirSchema = z.object({
  hourly: z.object({
    time: arr(z.string()),
    pm2_5: arr(numOrNull),
    pm10: arr(numOrNull),
  }),
});
export type UpstreamAir = z.infer<typeof upstreamAirSchema>;

/** geocoding search 接口：没结果时连 results 都没有 */
export const upstreamGeoSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: num,
        longitude: num,
        feature_code: z.string().optional(),
        country: z.string().optional(),
        admin1: z.string().optional(),
        population: z.number().optional(),
      }),
    )
    .optional(),
});
export type UpstreamGeo = z.infer<typeof upstreamGeoSchema>;

/** 本地时间的整点 "2026-11-26T15:00"（地点当地时间，不带时区） */
const hourKey = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:00$/);
const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** 一个整点：t 气温、f 体感、p 降水概率 %、r 降水 mm、s 降雪 cm、c 天气代码（WMO）、uv、d 白天 1、g 最大阵风 km/h、v 能见度 m、pm25 / pm10（取不到为 null） */
export const wxHourSchema = z.object({
  at: hourKey,
  t: num,
  f: num,
  p: num,
  r: num,
  s: num,
  c: z.number().int(),
  uv: num,
  d: z.union([z.literal(0), z.literal(1)]),
  g: num,
  v: num,
  pm25: numOrNull,
  pm10: numOrNull,
});
export type WxHour = z.infer<typeof wxHourSchema>;

/** 一天：hi / lo 最高最低气温、uv 紫外线最大、p 降水概率最大 %、c 天气代码 */
export const wxDaySchema = z.object({ date: dateKey, hi: num, lo: num, uv: num, p: num, c: z.number().int() });
export type WxDay = z.infer<typeof wxDaySchema>;

/** /wx/v1/forecast 回给 App 的包：off 是地点的 UTC 偏移（秒）；days 从昨天起 9 天（past_days=1 降温要比昨天，forecast_days=8 含今天、半屏列未来 7 天）；
 *  hours 只留昨天、今天、明天三天的连续整点（过去 12 小时、剩下时段、接下来 12 小时都在里面） */
export const wxPackSchema = z.object({
  v: z.literal(1),
  off: z.number().int(),
  cur: z.object({ t: num, f: num, c: z.number().int(), d: z.union([z.literal(0), z.literal(1)]) }),
  days: z.array(wxDaySchema).max(10),
  hours: z.array(wxHourSchema).max(24 * 4),
  /** 空气质量这一份取到没有（取不到时各小时 pm25、pm10 为 null，“戴好口罩”不判） */
  air: z.boolean(),
});
export type WxPack = z.infer<typeof wxPackSchema>;

/** /wx/v1/geo 回给 App 的城市：坐标已是粗坐标 */
export const wxPlaceSchema = z.object({
  /** 内置常用城市的 key（shared/logic/weather/cities.ts）：有它时城市名跟着界面语言变 */
  key: z.string().max(40).optional(),
  name: z.string().min(1).max(80),
  sub: z.string().max(120),
  lat: num,
  lon: num,
});
export type WxPlace = z.infer<typeof wxPlaceSchema>;
export const wxPlacesSchema = z.object({ places: z.array(wxPlaceSchema).max(10) });
