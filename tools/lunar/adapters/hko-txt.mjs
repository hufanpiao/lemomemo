// 香港天文台《公历与农历日期对照表》文本版 → 中间格式（B2 BE-5；负责人 11-03 定 R-299、R-306、R-309）。
// 读 tools/lunar/raw/hko/T1901c.txt～T2100c.txt（UTF-8 带 BOM、CRLF、繁体；原始文件只读不改），先按同目录 SHA256SUMS 逐个核对，
// 对不上、缺文件、多出没登记的文件都报错退出，不生成任何东西。核对通过后写：
//   tools/lunar/sources/cn-months.json  中间格式月表 { y, m, leap, start, days }（开头 1901-01-01～19 那段月名推不出来〔可能是冬月也可能是闰冬月〕，不收；
//                                      最后一个月到 2100-12-31 还没结束，照收，标 open: true，days 只算到数据结尾那天）
//   tools/lunar/sources/cn-terms.json   中间格式节气 { y, terms: 24 个日期（从小寒起）}
// 用法：node tools/lunar/adapters/hko-txt.mjs          转换并写文件
//       node tools/lunar/adapters/hko-txt.mjs --check  只转换核对、和已有的 sources/*.json 比对，不写
//
// 表格每行：“YYYY年M月D日  农历日  星期  节气”。农历日是“初二”“十一”“廿九”“三十”这样的字；每月第一天不写“初一”，写月名（“正月”“二月”…“十二月”，闰月写“閏四月”）。
// 农历年号：遇到“正月”就进入新的农历年（年号 = 正月初一所在的公历年）；数据开头 1901 年 1 月还在农历 1900 年（十一月、十二月），记为 1900。
// 时间以香港时间（UTC+8，与北京时间同）为准；1941～1945 等年份表尾有“夏令时间”说明，只影响时刻，不影响日期，忽略。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { dateOf, dayNum } from '../lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RAW = join(HERE, '..', 'raw', 'hko');
export const SRC = join(HERE, '..', 'sources');
export const FIRST_YEAR = 1901;
export const LAST_YEAR = 2100;

/** 24 节气，从小寒起（繁体原文 → 简体标识；中间格式只存日期，顺序就是标识，这里用来核对顺序） */
export const TERMS = [
  ['小寒', '小寒'], ['大寒', '大寒'], ['立春', '立春'], ['雨水', '雨水'], ['驚蟄', '惊蛰'], ['春分', '春分'],
  ['清明', '清明'], ['穀雨', '谷雨'], ['立夏', '立夏'], ['小滿', '小满'], ['芒種', '芒种'], ['夏至', '夏至'],
  ['小暑', '小暑'], ['大暑', '大暑'], ['立秋', '立秋'], ['處暑', '处暑'], ['白露', '白露'], ['秋分', '秋分'],
  ['寒露', '寒露'], ['霜降', '霜降'], ['立冬', '立冬'], ['小雪', '小雪'], ['大雪', '大雪'], ['冬至', '冬至'],
];
const TERM_INDEX = new Map(TERMS.map(([t], i) => [t, i]));

const MONTH_NAMES = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
const DAY_NAMES = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];

/** “閏四月” → { m: 4, leap: true }；不是月名返回 null */
export function parseMonthName(s) {
  const leap = s.startsWith('閏');
  const body = leap ? s.slice(1) : s;
  if (!body.endsWith('月')) return null;
  const k = MONTH_NAMES.indexOf(body.slice(0, -1));
  return k < 0 ? null : { m: k + 1, leap };
}

/** SHA256SUMS 本身的哈希（换行统一成 LF 后算；防止有人连同原始文件一起改掉 SHA256SUMS）。原始历表真要换版本时，和 SOURCE.md 一起改这里 */
export const SUMS_SHA256 = '469afee855928f948f29e8830b27bd6470114b9189efbfd61e8264d08c44d00e';
/** raw/hko 目录只许有这些文件：200 个 T*.txt + 3 个说明/校验文件，多别的一律报错 */
export const ALLOWED_EXTRA = ['SHA256SUMS', 'SOURCE.md', '.gitattributes'];

/**
 * 按 SHA256SUMS 核对 raw/hko 下的全部 T*.txt；返回问题列表（空 = 通过）。
 * expectSums：SHA256SUMS 自身应有的哈希（默认 SUMS_SHA256；测试用假目录时传 null 跳过）
 * @param {string} [dir]
 * @param {string | null} [expectSums]
 */
export function verifySums(dir = RAW, expectSums = SUMS_SHA256) {
  const errs = [];
  if (!existsSync(dir)) return [`缺原始历表目录 ${dir}`];
  const sumsPath = join(dir, 'SHA256SUMS');
  if (!existsSync(sumsPath)) return [`缺 ${sumsPath}`];
  const sumsText = readFileSync(sumsPath, 'utf8');
  if (expectSums) {
    const got = createHash('sha256').update(sumsText.replace(/\r\n/g, '\n')).digest('hex');
    if (got !== expectSums) errs.push(`SHA256SUMS 本身的哈希对不上：应为 ${expectSums}，实际 ${got}（原始历表换版本要同时改 hko-txt.mjs 的 SUMS_SHA256）`);
  }
  const listed = new Map();
  for (const line of sumsText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line.trim());
    if (!m) { errs.push(`SHA256SUMS 行格式不对：${line}`); continue; }
    if (listed.has(m[2])) errs.push(`SHA256SUMS 重复登记 ${m[2]}`);
    listed.set(m[2], m[1]);
  }
  const want = new Set();
  for (let y = FIRST_YEAR; y <= LAST_YEAR; y++) want.add(`T${y}c.txt`);
  for (const n of want) if (!listed.has(n)) errs.push(`SHA256SUMS 没登记 T${n.slice(1, 5)}c.txt`);
  for (const n of listed.keys()) if (!want.has(n)) errs.push(`SHA256SUMS 登记了不该有的 ${n}`);
  for (const n of readdirSync(dir)) if (!want.has(n) && !ALLOWED_EXTRA.includes(n)) errs.push(`原始历表目录里有不该有的 ${n}（只许 T1901c.txt～T2100c.txt 和 ${ALLOWED_EXTRA.join('、')}）`);
  for (const [name, hash] of listed) {
    const p = join(dir, name);
    if (!existsSync(p)) { errs.push(`缺文件 ${name}`); continue; }
    const got = createHash('sha256').update(readFileSync(p)).digest('hex');
    if (got !== hash) errs.push(`${name} 的 SHA256 对不上：应为 ${hash}，实际 ${got}`);
  }
  return errs;
}

/** 读一个年份文件 → [{ date, lday, term }]（lday 是农历日那一栏原文，term 是节气原文或 ''） */
export function parseYearFile(text, year) {
  const rows = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\S+)\s+(星期\S)\s*(\S*)\s*$/.exec(raw);
    if (!m) {
      if (/^\d{4}年\d{1,2}月\d{1,2}日/.test(raw)) throw new Error(`T${year}c.txt 认不出的行：${raw.trim()}`);
      continue;
    }
    if (Number(m[1]) !== year) throw new Error(`T${year}c.txt 里出现别的年份：${raw.trim()}`);
    rows.push({ date: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`, lday: m[4], term: m[6] ?? '' });
  }
  return rows;
}

/** 把逐日行（跨所有年份、按日期顺序）转成中间格式；发现任何异常都抛错 */
export function convert(rows) {
  // 逐日连续
  for (let i = 1; i < rows.length; i++) {
    if (dayNum(rows[i].date) !== dayNum(rows[i - 1].date) + 1) throw new Error(`日期不连续：${rows[i - 1].date} 之后是 ${rows[i].date}`);
  }
  // 月份：找出每个“月名”行（初一）
  const heads = [];
  rows.forEach((r, i) => {
    const mn = parseMonthName(r.lday);
    if (mn) heads.push({ i, ...mn });
    else if (!DAY_NAMES.includes(r.lday) || r.lday === '初一') throw new Error(`${r.date}：农历日“${r.lday}”认不出`);
  });
  // 逐日核对：两个月名之间应依次是 初二、初三…
  for (let h = 0; h < heads.length; h++) {
    const end = h + 1 < heads.length ? heads[h + 1].i : rows.length;
    for (let i = heads[h].i + 1; i < end; i++) {
      const want = DAY_NAMES[i - heads[h].i];
      if (rows[i].lday !== want) throw new Error(`${rows[i].date}：农历日应为“${want}”，表上是“${rows[i].lday}”`);
    }
  }
  // 数据开头不是初一的那几天：往回推，倒数第一个月名前面那段的农历日要连续（核对用，不收进月表）
  if (heads.length === 0) throw new Error('一个月名都没找到');
  for (let i = 1; i < heads[0].i; i++) {
    if (DAY_NAMES.indexOf(rows[i].lday) !== DAY_NAMES.indexOf(rows[i - 1].lday) + 1) throw new Error(`${rows[i].date}：开头几天的农历日不连续`);
  }
  // 农历年号：第一个正月之前的月属于上一年
  const firstJan = heads.find((x) => x.m === 1 && !x.leap);
  if (!firstJan) throw new Error('没找到正月');
  let y = Number(rows[firstJan.i].date.slice(0, 4)) - 1;
  const months = [];
  for (let h = 0; h < heads.length; h++) {
    const a = heads[h];
    if (a.m === 1 && !a.leap) y = Number(rows[a.i].date.slice(0, 4));
    if (h + 1 < heads.length) {
      months.push({ y, m: a.m, leap: a.leap, start: rows[a.i].date, days: heads[h + 1].i - a.i });
    } else {
      // 最后一个月：数据到这里就完了，不知道是大月还是小月；照收，标 open，days 只算到数据结尾（运行时覆盖到这天为止）
      months.push({ y, m: a.m, leap: a.leap, start: rows[a.i].date, days: rows.length - a.i, open: true });
    }
  }
  // 节气：按公历年收，每年 24 个、顺序从小寒到冬至
  const byYear = new Map();
  for (const r of rows) {
    if (!r.term) continue;
    const idx = TERM_INDEX.get(r.term);
    if (idx === undefined) throw new Error(`${r.date}：节气“${r.term}”认不出`);
    const yy = Number(r.date.slice(0, 4));
    const list = byYear.get(yy) ?? [];
    if (idx !== list.length) throw new Error(`${r.date}：${yy} 年第 ${list.length + 1} 个节气应为“${TERMS[list.length]?.[0]}”，表上是“${r.term}”`);
    list.push(r.date);
    byYear.set(yy, list);
  }
  const terms = [...byYear].map(([yy, list]) => {
    if (list.length !== 24) throw new Error(`${yy} 年节气 ${list.length} 个，不是 24`);
    return { y: yy, terms: list };
  });
  return { months, terms };
}

/** 整个流程：核对 SHA256 → 读 200 个文件 → 转换。返回 { months, terms } */
export function run(dir = RAW) {
  const errs = verifySums(dir);
  if (errs.length > 0) throw new Error(`原始文件核对没通过（tools/lunar/raw/hko/SHA256SUMS）：\n${errs.join('\n')}`);
  const rows = [];
  for (let y = FIRST_YEAR; y <= LAST_YEAR; y++) {
    const r = parseYearFile(readFileSync(join(dir, `T${y}c.txt`), 'utf8'), y);
    const want = dayNum(`${y + 1}-01-01`) - dayNum(`${y}-01-01`);
    if (r.length !== want) throw new Error(`T${y}c.txt 有 ${r.length} 天，应为 ${want}`);
    if (r[0].date !== `${y}-01-01` || r.at(-1).date !== dateOf(dayNum(`${y + 1}-01-01`) - 1)) throw new Error(`T${y}c.txt 首尾日期不对`);
    rows.push(...r);
  }
  return convert(rows);
}

/** JSON 写法：一个月 / 一年一行，便于 diff 和人工核对 */
export function toJson(list) {
  return `[\n${list.map((x) => JSON.stringify(x)).join(',\n')}\n]\n`;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  let out;
  try {
    out = run();
  } catch (e) {
    stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    exit(1);
  }
  const files = [['cn-months.json', toJson(out.months)], ['cn-terms.json', toJson(out.terms)]];
  if (argv.includes('--check')) {
    const bad = files.filter(([n, t]) => !existsSync(join(SRC, n)) || readFileSync(join(SRC, n), 'utf8') !== t).map(([n]) => n);
    if (bad.length > 0) {
      stderr.write(`tools/lunar/sources/ 下 ${bad.join('、')} 和原始历表不一致：跑 node tools/lunar/adapters/hko-txt.mjs 重新生成\n`);
      exit(1);
    }
    stdout.write('cn-months.json、cn-terms.json 和香港天文台原始历表一致\n');
  } else {
    mkdirSync(SRC, { recursive: true });
    for (const [n, t] of files) writeFileSync(join(SRC, n), t, 'utf8');
    stdout.write(`已写 ${out.months.length} 个农历月（${out.months[0].y}～${out.months.at(-1).y}）、${out.terms.length} 年节气到 tools/lunar/sources/\n`);
  }
}
