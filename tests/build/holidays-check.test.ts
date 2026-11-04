// tools/holidays/check.mjs 的单测（B2 BE-5；格式见 tools/holidays/README.md）。
// 【样例数据】下面所有节假日都是虚构的：年份用 2099，名称一律写“样例”，日期只是为了凑出星期几，和任何真实的放假安排无关。
// 另外核对：本脚本判为合格的样例，前端 parseHolidayFile（shared/logic/calendar/holidays.ts）也能读（格式两边一致）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDir, checkFile, validateHolidayJson, weekdayOf } from '../../tools/holidays/check.mjs';
import { parseHolidayFile } from '../../shared/logic/calendar/holidays.ts';

/** 样例：中国 2099（虚构）。01-01 周四、01-02 周五放假，01-04 周日补班 */
const SAMPLE_CN = {
  country: 'cn',
  year: 2099,
  days: [
    { date: '2099-01-01', kind: 'off', name: { zh: '样例假日', ko: '샘플 휴일' } },
    { date: '2099-01-02', kind: 'off', name: { zh: '样例假日' } },
    { date: '2099-01-04', kind: 'work', name: { zh: '样例补班' } },
  ],
};

/** 样例：韩国 2099（虚构）。05-03 周日放假（同一天两个样例节日），05-04 周一替代公休日 */
const SAMPLE_KR = {
  country: 'kr',
  year: 2099,
  days: [
    { date: '2099-05-03', kind: 'off', name: { ko: '샘플 공휴일 가', zh: '样例节日甲' } },
    { date: '2099-05-03', kind: 'off', name: { ko: '샘플 공휴일 나' } },
    { date: '2099-05-04', kind: 'off', sub: true, name: { ko: '대체공휴일(샘플)' } },
  ],
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
type Day = Record<string, unknown>;
const withDay = (base: { days: Day[] }, i: number, patch: Day) => {
  const c = clone(base) as { days: Day[] };
  c.days[i] = { ...c.days[i], ...patch };
  return c;
};
const has = (errs: string[], s: string) => errs.some((e) => e.includes(s));

describe('validateHolidayJson：合格的样例', () => {
  it('样例日期的星期几和注释一致', () => {
    expect([weekdayOf('2099-01-01'), weekdayOf('2099-01-04'), weekdayOf('2099-05-03'), weekdayOf('2099-05-04')]).toEqual([4, 0, 0, 1]);
    expect(weekdayOf('2099-02-29')).toBeNull();
  });
  it('中国样例（放假 + 补班）、韩国样例（同日两节 + 替代公休日）都通过', () => {
    expect(validateHolidayJson(SAMPLE_CN, 'cn', 2099)).toEqual([]);
    expect(validateHolidayJson(SAMPLE_KR, 'kr', 2099)).toEqual([]);
  });
  it('[] 和 days 为空都算“这一年没有节假日”', () => {
    expect(validateHolidayJson([], 'cn', 2099)).toEqual([]);
    expect(validateHolidayJson({ country: 'kr', year: 2099, days: [] }, 'kr', 2099)).toEqual([]);
  });
  it('中国未公布的占位文件 {pending: true, days: []} 通过，前端当“没有节假日”；pending 配非空 days、非 true、韩国都拦', () => {
    const pending = { country: 'cn', year: 2099, pending: true, days: [] };
    expect(validateHolidayJson(pending, 'cn', 2099)).toEqual([]);
    expect(parseHolidayFile(pending, 'cn', 2099)?.days).toEqual([]);
    expect(has(validateHolidayJson({ ...SAMPLE_CN, pending: true }, 'cn', 2099), 'days 必须为空')).toBe(true);
    expect(has(validateHolidayJson({ ...pending, pending: 'yes' }, 'cn', 2099), 'pending 只能写 true')).toBe(true);
    expect(has(validateHolidayJson({ ...pending, country: 'kr' }, 'kr', 2099), '只有中国的下一年')).toBe(true);
  });
  it('前端 parseHolidayFile 也认这两份样例（sub 字段前端忽略，不影响读取）', () => {
    expect(parseHolidayFile(SAMPLE_CN, 'cn', 2099)?.days).toHaveLength(3);
    expect(parseHolidayFile(SAMPLE_KR, 'kr', 2099)?.days).toHaveLength(3);
  });
});

describe('validateHolidayJson：拦下来的情况', () => {
  it('顶层：不是对象、非空数组、多余字段、country 和目录不一致、year 和文件名不一致、days 不是数组', () => {
    expect(has(validateHolidayJson('x', 'cn', 2099), '顶层必须是对象')).toBe(true);
    expect(has(validateHolidayJson([1], 'cn', 2099), '只能是 []')).toBe(true);
    expect(has(validateHolidayJson({ ...SAMPLE_CN, note: 1 }, 'cn', 2099), '不认识的字段 note')).toBe(true);
    expect(has(validateHolidayJson(SAMPLE_CN, 'kr', 2099), '和目录 kr 不一致')).toBe(true);
    expect(has(validateHolidayJson(SAMPLE_CN, 'cn', 2098), '和文件名 2098 不一致')).toBe(true);
    expect(has(validateHolidayJson({ country: 'cn', year: 2099, days: {} }, 'cn', 2099), 'days 必须是数组')).toBe(true);
    expect(has(validateHolidayJson(SAMPLE_CN, 'jp', 2099), '不认识')).toBe(true);
  });
  it('日期：格式不对、不存在的日子、不在这一年、没排序', () => {
    expect(has(validateHolidayJson(withDay(SAMPLE_CN, 0, { date: '2099/01/01' }), 'cn', 2099), '不是合法的')).toBe(true);
    expect(has(validateHolidayJson(withDay(SAMPLE_CN, 0, { date: '2099-02-29' }), 'cn', 2099), '不是合法的')).toBe(true);
    expect(has(validateHolidayJson(withDay(SAMPLE_CN, 0, { date: '2098-12-31' }), 'cn', 2099), '不在 2099 年')).toBe(true);
    expect(has(validateHolidayJson(withDay(SAMPLE_CN, 1, { date: '2098-12-31' }), 'cn', 2098), '没有按日期从早到晚排')).toBe(true);
  });
  it('kind：只能 off / work；韩国不能有补班；补班必须在周末', () => {
    expect(has(validateHolidayJson(withDay(SAMPLE_CN, 0, { kind: 'holiday' }), 'cn', 2099), 'kind 只能是')).toBe(true);
    const krWork = withDay(SAMPLE_KR, 0, { kind: 'work' });
    expect(has(validateHolidayJson(krWork, 'kr', 2099), '只有中国有')).toBe(true);
    expect(has(validateHolidayJson(withDay(SAMPLE_CN, 2, { date: '2099-01-05' }), 'cn', 2099), '补班日应在周六或周日')).toBe(true);
  });
  it('放假和补班撞在同一天；完全重复的条目', () => {
    const c = clone(SAMPLE_CN) as { days: Day[] };
    c.days.splice(2, 0, { date: '2099-01-04', kind: 'off', name: { zh: '样例假日' } });
    expect(has(validateHolidayJson(c, 'cn', 2099), '既是放假又是补班')).toBe(true);
    const d = clone(SAMPLE_CN) as { days: Day[] };
    d.days.splice(1, 0, clone(d.days[0] as Day));
    expect(has(validateHolidayJson(d, 'cn', 2099), '重复的条目')).toBe(true);
  });
  it('替代公休日 sub：只能 true、只有韩国有、kind 必须 off、必须在工作日', () => {
    expect(has(validateHolidayJson(withDay(SAMPLE_KR, 2, { sub: false }), 'kr', 2099), 'sub 只能写 true')).toBe(true);
    expect(has(validateHolidayJson(withDay(SAMPLE_CN, 0, { sub: true }), 'cn', 2099), '只有韩国有')).toBe(true);
    expect(has(validateHolidayJson(withDay(SAMPLE_KR, 2, { date: '2099-05-09' }), 'kr', 2099), '应在工作日')).toBe(true);
    expect(weekdayOf('2099-05-09')).toBe(6);
  });
  it('名称：本国语言必填、空串、首尾空格、超长、控制字符、不认识的语言、多余字段', () => {
    expect(has(validateHolidayJson(withDay(SAMPLE_CN, 0, { name: { ko: '샘플' } }), 'cn', 2099), 'name.zh 必填')).toBe(true);
    expect(has(validateHolidayJson(withDay(SAMPLE_KR, 0, { name: { zh: '样例' } }), 'kr', 2099), 'name.ko 必填')).toBe(true);
    expect(has(validateHolidayJson(withDay(SAMPLE_CN, 0, { name: { zh: '' } }), 'cn', 2099), '非空字符串')).toBe(true);
    expect(has(validateHolidayJson(withDay(SAMPLE_CN, 0, { name: { zh: ' 样例' } }), 'cn', 2099), '首尾不能有空格')).toBe(true);
    expect(has(validateHolidayJson(withDay(SAMPLE_CN, 0, { name: { zh: '样'.repeat(41) } }), 'cn', 2099), '超过 40')).toBe(true);
    expect(has(validateHolidayJson(withDay(SAMPLE_CN, 0, { name: { zh: `样例${String.fromCharCode(0x202e)}` } }), 'cn', 2099), '不可见字符')).toBe(true);
    expect(has(validateHolidayJson(withDay(SAMPLE_CN, 0, { name: { zh: '样例', en: 'x' } }), 'cn', 2099), '不认识的字段 en')).toBe(true);
    expect(has(validateHolidayJson(withDay(SAMPLE_CN, 0, { note: 'x' }), 'cn', 2099), '不认识的字段 note')).toBe(true);
    expect(has(validateHolidayJson(withDay(SAMPLE_CN, 0, { name: '样例' }), 'cn', 2099), 'name 必须是对象')).toBe(true);
  });
});

describe('checkFile、checkDir（临时目录里的样例文件）', () => {
  let dir = '';
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'holidays-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const write = (rel: string, body: string | Buffer) => {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
    return p;
  };

  it('目录不在：0 个文件、不报错（缺明年文件归 check_arch W2）', () => {
    expect(checkDir(join(dir, 'no-such'))).toEqual({ errs: [], files: 0 });
  });
  it('合格的样例目录通过', () => {
    const root = join(dir, 'ok');
    write('ok/cn/2099.json', JSON.stringify(SAMPLE_CN));
    write('ok/kr/2099.json', JSON.stringify(SAMPLE_KR));
    expect(checkDir(root)).toEqual({ errs: [], files: 2 });
  });
  it('BOM、坏 JSON、超过 16 KB 都报', () => {
    expect(checkFile(write('f/bom.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[]')])), 'cn', 2099)[0]).toMatch(/BOM/);
    expect(checkFile(write('f/bad.json', '{'), 'cn', 2099)[0]).toMatch(/不是合法的 UTF-8 JSON/);
    expect(checkFile(write('f/big.json', ' '.repeat(16 * 1024 + 1)), 'cn', 2099)[0]).toMatch(/超过/);
  });
  it('目录结构：多余的国家目录、文件名不对、年份越界、文件放错国家', () => {
    const root = join(dir, 'bad');
    write('bad/jp/2099.json', '[]');
    write('bad/cn/2099.txt', '[]');
    write('bad/cn/1899.json', '[]');
    write('bad/kr/2099.json', JSON.stringify(SAMPLE_CN));
    const { errs } = checkDir(root) as { errs: string[] };
    expect(has(errs, 'jp：holidays/ 下只能有')).toBe(true);
    expect(has(errs, 'cn/2099.txt：文件名只能是')).toBe(true);
    expect(has(errs, 'cn/1899.json：年份不在')).toBe(true);
    expect(has(errs, 'kr/2099.json：country 是 "cn"，和目录 kr 不一致')).toBe(true);
  });
});
