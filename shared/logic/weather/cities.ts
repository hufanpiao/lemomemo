// 天气城市搜索的内置常用城市表（中韩两种名字、粗坐标）：
// • 为什么要：Open-Meteo 地理编码搜常用的两个字城市名不靠谱（11-26 真请求原文：서울 ko、首尔 zh 0 条；부산 第一条是충청북도的小地方；
//   东京 zh 回的是江苏、浙江的“东京”村；대구 第一条在朝鲜），所以搜索时先查这张表，表里有的排最前，再接 Open-Meteo 的结果
// • 城市名跟着界面语言：选了表里的城市只存它的 key，显示时按当前语言取名字（cityName）；不在表里的城市照旧存搜索时那种语言的名字
// • 坐标都是 1 位小数（同 /wx 只认粗坐标）
// 纯逻辑：不碰 DOM、不碰网络
import type { WxPlace } from '../../schema/weather.ts';
import { CITY_ROWS, COUNTRY, type CityLang, type Country } from './cities-data.ts';

type Lang = CityLang;

// 按语言、国家取名字一律走点号和 Map.get，不用方括号：这个文件会复制进服务器函数的 _shared/gen，
// check_backend F7 不许“键追不到字面量”的方括号取属性（参数、属性都算追不到）
const pick = (r: Record<Lang, string>, lang: Lang): string => (lang === 'ko' ? r.ko : r.zh);
const COUNTRY_NAME = new Map(Object.entries(COUNTRY));

/** 比对用：小写、去空白和点 */
const norm = (s: string): string => s.toLowerCase().replace(/[\s.·'’-]/g, '');

interface City {
  key: string;
  name: Record<Lang, string>;
  country: Country;
  lat: number;
  lon: number;
  /** 比对用的全部写法（已 norm） */
  spell: readonly string[];
}

const CITIES: readonly City[] = CITY_ROWS.map(([key, zh, ko, en, country, lat, lon, ...alias]) => ({
  key,
  name: { zh, ko },
  country,
  lat,
  lon,
  spell: [zh, ko, en, key, ...alias].map(norm),
}));
const BY_KEY = new Map(CITIES.map((c) => [c.key, c]));

/**
 * 搜索词碰上了哪些内置城市（按表里的先后）：某种写法以搜索词开头（“서” → 서울），或搜索词以某种写法开头（“서울시”“上海市” → 서울、上海，
 * 这一种写法至少 2 个字，免得“北”配上别的）
 */
export function matchCities(q: string, lang: Lang): WxPlace[] {
  const n = norm(q);
  if (!n) return [];
  return CITIES.filter((c) => c.spell.some((s) => s.startsWith(n) || (s.length >= 2 && n.startsWith(s)))).map((c) => ({
    key: c.key,
    name: pick(c.name, lang),
    sub: pick(COUNTRY_NAME.get(c.country) ?? { zh: '', ko: '' }, lang),
    lat: c.lat,
    lon: c.lon,
  }));
}

/** 城市显示名：内置城市按当前语言取，别的用存下的名字 */
export function cityName(place: { key?: string | undefined; name: string }, lang: Lang): string {
  const c = place.key === undefined ? undefined : BY_KEY.get(place.key);
  return c ? pick(c.name, lang) : place.name;
}

/** 内置城市和 Open-Meteo 的结果合在一起：内置的在前；Open-Meteo 里离某个内置城市不到 0.3°（约 30 公里）的同一处不再列；最多 limit 条 */
export function mergePlaces(own: readonly WxPlace[], up: readonly WxPlace[], limit: number): WxPlace[] {
  const near = (a: WxPlace, b: WxPlace): boolean => Math.abs(a.lat - b.lat) < 0.3 && Math.abs(a.lon - b.lon) < 0.3;
  return [...own, ...up.filter((u) => !own.some((o) => near(o, u)))].slice(0, limit);
}
