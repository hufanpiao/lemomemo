// 阴历数据工具链（B2 任务单 BE-5、第一天派工表第 7 行；架构审 D5、5.12）的核心：中间格式 → 紧凑编码 → 校验 → 两国逐月比对。
// 只用纯 JS，不联网、不读环境变量。数据来源各写一个适配器（香港天文台历表 → 中国；KASI → 韩国），都先转成下面的“中间格式”，
// 再由 build.mjs 编码写进 shared/logic/anniv/lunar-data.ts（只在日历页、今天页显示农历时按需加载，2.6 单独 chunk）。
//
// 中间格式（每个来源、每个国家一份，逐个农历月一行）：
//   { y: 农历年, m: 农历月 1～12, leap: 是否闰月, start: 'YYYY-MM-DD'（这个月初一的公历日期）, days: 29 | 30 }
// 节气（另一份）：{ y: 公历年, terms: ['YYYY-MM-DD', …24 个，从小寒开始] }
//
// 紧凑编码（每个农历年一个整数，和常见的农历表同一思路，便于逐月比对和人工核对）：
//   bit 0～12：第 1～13 个月是不是大月（30 天）；bit 13～16：闰几月（0 = 没有闰月）；另存每年正月初一相对 1970-01-01 的天数
//   → 一年 = [newYearDay, bits]。节气每年 24 个“相对当年 1 月 1 日的天数”（0～365）。
const DAY_MS = 86_400_000;

export function dayNum(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad_date:${s}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(t);
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() + 1 !== Number(m[2]) || d.getUTCDate() !== Number(m[3])) throw new Error(`bad_date:${s}`);
  return Math.round(t / DAY_MS);
}

export function dateOf(n) {
  const d = new Date(n * DAY_MS);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** 中间格式的月份表做结构校验；返回问题列表（空 = 通过） */
export function validateMonths(months) {
  const errs = [];
  for (let i = 0; i < months.length; i++) {
    const a = months[i];
    if (a.days !== 29 && a.days !== 30) errs.push(`${a.y}-${a.leap ? '闰' : ''}${a.m}：天数 ${a.days} 不是 29 或 30`);
    if (!(a.m >= 1 && a.m <= 12)) errs.push(`${a.y}：月份 ${a.m} 不在 1～12`);
    const b = months[i + 1];
    if (!b) continue;
    if (dayNum(a.start) + a.days !== dayNum(b.start)) errs.push(`${a.y}-${a.leap ? '闰' : ''}${a.m}：初一 ${a.start} 加 ${a.days} 天不等于下个月初一 ${b.start}`);
    const next = b.leap ? b.m === a.m && !a.leap : (a.m === 12 ? b.m === 1 && b.y === a.y + 1 : b.m === a.m + 1 && b.y === a.y);
    if (!next) errs.push(`${a.y}-${a.leap ? '闰' : ''}${a.m} 后面接的是 ${b.y}-${b.leap ? '闰' : ''}${b.m}，顺序不对`);
  }
  const perYear = new Map();
  for (const a of months) perYear.set(a.y, [...(perYear.get(a.y) ?? []), a]);
  for (const [y, ms] of perYear) {
    const leaps = ms.filter((a) => a.leap).length;
    if (leaps > 1) errs.push(`${y}：闰月不止一个`);
    if (ms.length === 12 + leaps && ms[0]?.m === 1) {
      const len = ms.reduce((n, a) => n + a.days, 0);
      if (len < 353 || len > 385) errs.push(`${y}：全年 ${len} 天，不在 353～385`);
    }
  }
  return errs;
}

/** 中间格式 → { first: 第一个农历年, years: [[newYearDay, bits], …] }；只收完整的农历年（正月到腊月） */
export function encodeMonths(months) {
  const years = [];
  let first = null;
  for (let i = 0; i < months.length; ) {
    const a = months[i];
    if (a.m !== 1 || a.leap) { i++; continue; }
    const ms = [];
    let j = i;
    while (j < months.length && months[j].y === a.y) ms.push(months[j++]);
    if (ms.length < 12 || ms[ms.length - 1].m !== 12) break;   // 不完整的一年（数据结尾）不收
    let bits = 0;
    let leap = 0;
    ms.forEach((x, k) => {
      if (x.days === 30) bits |= 1 << k;
      if (x.leap) leap = x.m;
    });
    bits |= leap << 13;
    if (first === null) first = a.y;
    else if (a.y !== first + years.length) throw new Error(`农历年不连续：${first + years.length} 之后是 ${a.y}`);
    years.push([dayNum(a.start), bits]);
    i = j;
  }
  return { first, years };
}

/** encodeMonths 的逆运算（lunar-data.ts 里的 decode 和它是同一逻辑，tests/build/lunar-tools.test.ts 核对往返） */
export function decodeYears({ first, years }) {
  const out = [];
  years.forEach(([ny, bits], k) => {
    const y = first + k;
    const leap = (bits >> 13) & 0xf;
    const count = leap ? 13 : 12;
    let d = ny;
    let m = 1;
    let leapDone = false;
    for (let i = 0; i < count; i++) {
      const isLeap = leap !== 0 && !leapDone && i === leap;
      if (isLeap) leapDone = true;
      const days = (bits >> i) & 1 ? 30 : 29;
      out.push({ y, m: isLeap ? leap : m, leap: isLeap, start: dateOf(d), days });
      d += days;
      if (!isLeap) m++;
    }
  });
  return out;
}

/** 两国逐月比对（CI）：同一个农历年月的初一日期、大小月、闰月位置不同的都列出来（中韩历法用不同的经度，个别月份本来就会差一天，由 allow 白名单说明） */
export function compareCountries(cn, kr, allow = []) {
  const key = (a) => `${a.y}-${a.leap ? 'L' : ''}${a.m}`;
  const kmap = new Map(kr.map((a) => [key(a), a]));
  const ok = new Set(allow);
  const diffs = [];
  for (const a of cn) {
    const b = kmap.get(key(a));
    if (!b) continue;
    if (a.start !== b.start || a.days !== b.days) {
      const k = key(a);
      if (!ok.has(k)) diffs.push({ key: k, cn: `${a.start}/${a.days}`, kr: `${b.start}/${b.days}` });
    }
  }
  const cnKeys = new Set(cn.map(key));
  const minY = Math.max(cn[0]?.y ?? 0, kr[0]?.y ?? 0);
  const maxY = Math.min(cn.at(-1)?.y ?? 0, kr.at(-1)?.y ?? 0);
  for (const b of kr) if (b.y >= minY && b.y <= maxY && !cnKeys.has(key(b)) && !ok.has(key(b))) diffs.push({ key: key(b), cn: '—', kr: `${b.start}/${b.days}` });
  return diffs;
}

/** 节气：[{y, terms: 24 个日期}] → { first, years: [[24 个相对当年 1 月 1 日的天数]] } */
export function encodeTerms(list) {
  const sorted = [...list].sort((a, b) => a.y - b.y);
  const first = sorted[0]?.y ?? null;
  const years = sorted.map((t, k) => {
    if (t.y !== first + k) throw new Error(`节气年份不连续：${first + k} 之后是 ${t.y}`);
    if (t.terms.length !== 24) throw new Error(`${t.y}：节气 ${t.terms.length} 个，不是 24`);
    const base = dayNum(`${t.y}-01-01`);
    const offs = t.terms.map((d) => dayNum(d) - base);
    offs.forEach((o, i) => {
      if (o < 0 || o > 365 || (i > 0 && o <= offs[i - 1])) throw new Error(`${t.y}：第 ${i + 1} 个节气 ${t.terms[i]} 顺序或范围不对`);
    });
    return offs;
  });
  return { first, years };
}

/** 生成 lunar-data.ts 的源码（只放数据和一个解码函数，不 import 别的模块，单独 chunk） */
export function renderDataTs({ cn, kr, termsCn, termsKr, generatedFrom }) {
  const arr = (v) => JSON.stringify(v);
  return `// 自动生成，不要手改：node tools/lunar/build.mjs（来源：${generatedFrom}）
// 农历月表（中国：香港天文台；韩国：KASI）和 24 节气。编码见 tools/lunar/lib.mjs 文件头：每年 [正月初一相对 1970-01-01 的天数, 大小月和闰月位]；
// 节气每年 24 个相对当年 1 月 1 日的天数（从小寒起）。只在日历页、今天页显示农历时按需加载（架构 2.6）
export interface LunarTable { first: number; years: readonly (readonly [number, number])[] }
export interface TermTable { first: number; years: readonly (readonly number[])[] }
export const LUNAR_CN: LunarTable = { first: ${cn.first}, years: ${arr(cn.years)} };
export const LUNAR_KR: LunarTable = { first: ${kr.first}, years: ${arr(kr.years)} };
export const TERMS_CN: TermTable = { first: ${termsCn.first}, years: ${arr(termsCn.years)} };
export const TERMS_KR: TermTable = { first: ${termsKr.first}, years: ${arr(termsKr.years)} };
`;
}
