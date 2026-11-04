// 节假日 JSON 校验（B2 BE-5；架构 5.12 第 1 点、2.3 W2；格式见同目录 README.md）。纯 JS，不联网、不读环境变量。
// 用法：node tools/holidays/check.mjs                 校验 src/public/holidays/ 下所有 <cn|kr>/<年>.json（CI：npm run check:holidays）
//       node tools/holidays/check.mjs --root <目录>   校验别的目录（测试用）
// 目录或文件还没有时不报错：缺明年文件由 check_arch W2 报警告，这里只管“已有的文件对不对”。
// 比前端的 parseHolidayFile（shared/logic/calendar/holidays.ts）更严：前端遇到坏文件只是不显示，这里在构建前就拦下来，
// 并多查前端不查的几条（多余字段、排序、重复、放假和补班撞日、补班必须在周末、替代公休日必须在工作日、本国语言名称必填）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_DIR = join(ROOT, 'src', 'public', 'holidays');
export const COUNTRIES = ['cn', 'kr'];
const FILE_RE = /^(\d{4})\.json$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 名称上限和前端 parseHolidayFile 一致 */
export const NAME_MAX = 40;
/** 单个文件上限：一年的节假日不到 3 KB，超过 16 KB 多半是放错了东西 */
export const FILE_MAX_BYTES = 16 * 1024;
const TOP_KEYS = new Set(['country', 'year', 'days', 'pending']);
const DAY_KEYS = new Set(['date', 'kind', 'name', 'sub']);
const NAME_KEYS = new Set(['zh', 'ko']);
// 控制字符、零宽字符和双向控制字符（Unicode 码位写成转义，源码里不放这些字符本身）
const BAD_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]];
/** 有没有控制字符、零宽字符、双向控制字符 */
function hasBadChar(s) {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (BAD_RANGES.some(([lo, hi]) => c >= lo && c <= hi)) return true;
  }
  return false;
}

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 'YYYY-MM-DD' → 星期几（0 = 周日）；不是合法日期返回 null */
export function weekdayOf(s) {
  const m = typeof s === 'string' ? DATE_RE.exec(s) : null;
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return t.getUTCDay();
}

function checkName(name, country, where, errs) {
  if (!isObj(name)) {
    errs.push(`${where}：name 必须是对象 {zh?, ko?}`);
    return;
  }
  for (const k of Object.keys(name)) if (!NAME_KEYS.has(k)) errs.push(`${where}：name 里有不认识的字段 ${k}`);
  for (const k of NAME_KEYS) {
    const v = name[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.trim() === '' || v !== v.trim()) errs.push(`${where}：name.${k} 必须是非空字符串，首尾不能有空格`);
    else if (v.length > NAME_MAX) errs.push(`${where}：name.${k} 超过 ${NAME_MAX} 个字符`);
    else if (hasBadChar(v)) errs.push(`${where}：name.${k} 里有控制字符或不可见字符`);
  }
  const native = country === 'cn' ? 'zh' : 'ko';
  if (name[native] === undefined) errs.push(`${where}：本国语言的名称 name.${native} 必填`);
  // R-338（11-04 负责人定）：韩文界面显示中国节假日的韩文名，所以中国的每一条 name.ko 也必填（韩国的 name.zh 仍可不填）
  else if (country === 'cn' && name.ko === undefined) errs.push(`${where}：中国节假日的韩文名 name.ko 必填（R-338）`);
}

/**
 * 校验一份已解析的 JSON。country、year 是从路径得来的期望值。返回问题列表（空 = 通过）。
 * 允许整份是 `[]`（这一年没有节假日或还没公布，和前端约定一致）；本项目约定不提前建空文件（见 README）。
 */
export function validateHolidayJson(json, country, year) {
  const errs = [];
  if (!COUNTRIES.includes(country)) return [`国家 ${country} 不认识，只能是 ${COUNTRIES.join('、')}`];
  if (Array.isArray(json)) return json.length === 0 ? [] : ['顶层是数组时只能是 []（表示这一年没有节假日）'];
  if (!isObj(json)) return ['顶层必须是对象 {country, year, days}'];
  for (const k of Object.keys(json)) if (!TOP_KEYS.has(k)) errs.push(`顶层有不认识的字段 ${k}`);
  if (json.country !== country) errs.push(`country 是 ${JSON.stringify(json.country)}，和目录 ${country} 不一致`);
  if (json.year !== year) errs.push(`year 是 ${JSON.stringify(json.year)}，和文件名 ${year} 不一致`);
  if (!Array.isArray(json.days)) {
    errs.push('days 必须是数组');
    return errs;
  }
  // pending：中国下一年还没公布时的占位文件（架构 5.12），只能是 true，且 days 必须为空；韩国不放占位文件
  if (json.pending !== undefined) {
    if (json.pending !== true) errs.push('pending 只能写 true（表示还没公布），公布了就去掉');
    if (json.days.length > 0) errs.push('写了 pending（未公布）的文件 days 必须为空');
    if (country !== 'cn') errs.push('只有中国的下一年可以放 pending 占位文件，韩国按월력요항写真实数据');
  }
  const kindsByDate = new Map();
  const seen = new Set();
  let prev = '';
  json.days.forEach((d, i) => {
    const where = `days[${i}]`;
    if (!isObj(d)) {
      errs.push(`${where}：必须是对象`);
      return;
    }
    for (const k of Object.keys(d)) if (!DAY_KEYS.has(k)) errs.push(`${where}：有不认识的字段 ${k}`);
    const wd = weekdayOf(d.date);
    if (wd === null) {
      errs.push(`${where}：date ${JSON.stringify(d.date)} 不是合法的 YYYY-MM-DD 日期`);
      return;
    }
    const at = `${where}（${d.date}）`;
    if (Number(d.date.slice(0, 4)) !== year) errs.push(`${at}：不在 ${year} 年`);
    if (d.date < prev) errs.push(`${at}：没有按日期从早到晚排`);
    prev = d.date > prev ? d.date : prev;
    if (d.kind !== 'off' && d.kind !== 'work') errs.push(`${at}：kind 只能是 off（放假）或 work（补班）`);
    if (d.kind === 'work') {
      if (country !== 'cn') errs.push(`${at}：补班（work）只有中国有`);
      if (wd !== 0 && wd !== 6) errs.push(`${at}：补班日应在周六或周日（调休把周末改成上班），这天是工作日`);
    }
    if (d.sub !== undefined) {
      if (d.sub !== true) errs.push(`${at}：sub 只能写 true，不是替代公休日就不写`);
      else {
        if (country !== 'kr') errs.push(`${at}：替代公休日（sub）只有韩国有`);
        if (d.kind !== 'off') errs.push(`${at}：替代公休日的 kind 必须是 off`);
        if (wd === 0 || wd === 6) errs.push(`${at}：替代公休日应在工作日，这天是周末`);
      }
    }
    checkName(d.name, country, at, errs);
    const kinds = kindsByDate.get(d.date) ?? new Set();
    kinds.add(d.kind);
    kindsByDate.set(d.date, kinds);
    if (kinds.has('off') && kinds.has('work')) errs.push(`${at}：同一天既是放假又是补班`);
    const key = `${d.date}|${d.kind}|${isObj(d.name) ? JSON.stringify([d.name.zh ?? '', d.name.ko ?? '']) : ''}`;
    if (seen.has(key)) errs.push(`${at}：重复的条目`);
    seen.add(key);
  });
  return errs;
}

/** 校验一个文件（读文件、大小、BOM、JSON 解析、内容）；返回问题列表 */
export function checkFile(path, country, year) {
  const buf = readFileSync(path);
  if (buf.length > FILE_MAX_BYTES) return [`文件 ${buf.length} 字节，超过 ${FILE_MAX_BYTES}`];
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return ['文件开头有 BOM，要存成不带 BOM 的 UTF-8'];
  let json;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf));
  } catch (e) {
    return [`不是合法的 UTF-8 JSON：${e instanceof Error ? e.message : String(e)}`];
  }
  return validateHolidayJson(json, country, year);
}

/**
 * 校验整个目录：只许有 cn/、kr/ 两个子目录，子目录里只许有 <四位年份>.json。
 * 返回 { errs: ['路径：问题', …], files: 校验过的文件数 }；目录不在算 0 个文件、不报错。
 */
export function checkDir(dir = DEFAULT_DIR) {
  const errs = [];
  let files = 0;
  if (!existsSync(dir)) return { errs, files };
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!COUNTRIES.includes(name) || !statSync(p).isDirectory()) {
      errs.push(`${name}：holidays/ 下只能有 cn/、kr/ 两个目录`);
      continue;
    }
    for (const f of readdirSync(p)) {
      const m = FILE_RE.exec(f);
      const fp = join(p, f);
      if (!m || !statSync(fp).isFile()) {
        errs.push(`${name}/${f}：文件名只能是“四位年份.json”`);
        continue;
      }
      const year = Number(m[1]);
      if (year < 1900 || year > 2100) {
        errs.push(`${name}/${f}：年份不在 1900～2100`);
        continue;
      }
      files++;
      for (const e of checkFile(fp, name, year)) errs.push(`${name}/${f}：${e}`);
    }
  }
  return { errs, files };
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  const i = argv.indexOf('--root');
  const dir = i >= 0 && argv[i + 1] ? argv[i + 1] : DEFAULT_DIR;
  const { errs, files } = checkDir(dir);
  if (errs.length > 0) {
    stderr.write(`节假日 JSON 校验没通过：\n${errs.join('\n')}\n`);
    exit(1);
  }
  stdout.write(files === 0 ? '还没有节假日文件（缺明年的文件由 check_arch W2 报警告）\n' : `节假日 JSON ${files} 个文件校验通过\n`);
}
