// 客户端错误日志 js_error（TC-B1-68）的审查建议 FE-1030-sugg ①②（10-30）：
// ① code 超长时先截文件名（留扩展名、补 ~），还超就行号、列号记 0，绝不截出像真数字的半截行列号；
// ② 一天 50 个不同 code 用完后，头一回挡下新 code 时记一条 js_error_codes_full（每台设备每天一条，跨重新载入也只一条）
import { afterEach, describe, expect, it } from 'vitest';
import {
  JS_ERROR_ACT, JS_ERROR_CODE_MAX, JS_ERROR_FULL_ACT, JS_ERROR_KEY, JS_ERROR_MAX_CODES, fitJsErrorCode, jsErrorCode, registerJsErrorLog,
} from '../env.ts';

const ORIGIN = 'https://lemomemo.com';
const PROBE = 'QA探针';

function memStorage(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

function errorEvent(error: unknown, filename: string, lineno: number): Event {
  const e = new Event('error');
  Object.assign(e, { error, filename, lineno, colno: 7, message: `Uncaught ${PROBE}` });
  return e;
}

function setup(over: { now?: () => number; storage?: Pick<Storage, 'getItem' | 'setItem'> | null } = {}) {
  const target = new EventTarget();
  const logs: { act: string; code: string }[] = [];
  const off = registerJsErrorLog((act, f) => logs.push({ act, code: f.code }), {
    target, origin: ORIGIN, now: over.now ?? (() => new Date(2026, 9, 30, 12).getTime()),
    storage: over.storage === undefined ? memStorage() : over.storage,
  });
  return { target, logs, off };
}

const offs: (() => void)[] = [];
afterEach(() => {
  while (offs.length) offs.pop()?.();
});

describe('FE-1030-sugg ① code 超长：先截文件名，绝不截出假数字', () => {
  const STEM = `${'a'.repeat(38)}zz`;   // 40 字，FILE_RE 允许的最长
  const LONG = `${ORIGIN}/app/assets/${STEM}.js`;

  it('40 字文件名 + 7 位行列号：截文件名（留 .js、补 ~），行号、列号原样；改前列号会被截成 “76”', () => {
    const code = jsErrorCode(new TypeError(PROBE), { filename: LONG, lineno: 1234567, colno: 7654321 }, ORIGIN);
    expect(code).toBe(`TypeError@${'a'.repeat(34)}~.js:1234567:7654321`);
    expect(code).toHaveLength(JS_ERROR_CODE_MAX);
    // 最长的白名单类型名也一样
    const t = Object.assign(new Error(PROBE), { name: 'TransactionInactiveError' });
    expect(jsErrorCode(t, { filename: LONG, lineno: 1234567, colno: 7654321 }, ORIGIN))
      .toBe(`TransactionInactiveError@${'a'.repeat(19)}~.js:1234567:7654321`);
  });

  it('不超长时原样、不加 ~；正好 64 字也不截', () => {
    expect(jsErrorCode(new TypeError(PROBE), { filename: LONG, lineno: 1, colno: 2 }, ORIGIN)).toBe(`TypeError@${STEM}.js:1:2`);
    expect(fitJsErrorCode('TypeError', 'index.html', 9_999_999, 9_999_999)).toBe('TypeError@index.html:9999999:9999999');
    const exact = fitJsErrorCode('A', `${'b'.repeat(55)}.js`, 1, 1);
    expect(exact).toHaveLength(JS_ERROR_CODE_MAX);
    expect(exact).not.toContain('~');
  });

  it('截了文件名还放不下：行号、列号记 0；连 0 也放不下才丢文件名，都不出现被截短的数字', () => {
    const t42 = 'T'.repeat(42);
    const z = fitJsErrorCode(t42, `${'x'.repeat(30)}.html`, 1234567, 7654321);
    expect(z).toBe(`${t42}@${'x'.repeat(11)}~.html:0:0`);
    expect(z).toHaveLength(JS_ERROR_CODE_MAX);
    const huge = fitJsErrorCode('T'.repeat(80), 'a.js', 1234567, 7654321);
    expect(huge).toBe(`${'T'.repeat(58)}@~:0:0`);
    expect(huge).toHaveLength(JS_ERROR_CODE_MAX);
    // 没有扩展名的（unknown）也只走这两步
    expect(fitJsErrorCode('T'.repeat(60), 'unknown', 12, 34)).toBe(`${'T'.repeat(58)}@~:0:0`);
    expect(fitJsErrorCode('T'.repeat(52), 'unknown', 12, 34)).toBe(`${'T'.repeat(52)}@unkn~:12:34`);
  });
});

describe('FE-1030-sugg ② 50 个 code 用完：每天记一条 js_error_codes_full', () => {
  const fireAll = (target: EventTarget, from: number, to: number): void => {
    for (let line = from; line <= to; line++) target.dispatchEvent(errorEvent(new TypeError(PROBE), `${ORIGIN}/app/assets/a.js`, line));
  };
  const fulls = (logs: { act: string }[]): number => logs.filter((l) => l.act === JS_ERROR_FULL_ACT).length;

  it('记满 50 个时还不记；第 51 个新 code 被挡下时记一条（code = 50），之后再挡也不记；已有的 code 照常记', () => {
    const s = setup();
    offs.push(s.off);
    fireAll(s.target, 1, JS_ERROR_MAX_CODES);
    expect(fulls(s.logs)).toBe(0);
    fireAll(s.target, JS_ERROR_MAX_CODES + 1, JS_ERROR_MAX_CODES + 20);
    expect(fulls(s.logs)).toBe(1);
    expect(s.logs.filter((l) => l.act === JS_ERROR_ACT)).toHaveLength(JS_ERROR_MAX_CODES);
    expect(s.logs[JS_ERROR_MAX_CODES]).toEqual({ act: JS_ERROR_FULL_ACT, code: String(JS_ERROR_MAX_CODES) });
    fireAll(s.target, 1, 1);
    expect(s.logs.at(-1)).toEqual({ act: JS_ERROR_ACT, code: 'TypeError@a.js:1:7' });
  });

  it('重新载入（同一份存储、新页面）当天不再记；第二天满了再记一条', () => {
    const storage = memStorage();
    let t = new Date(2026, 9, 30, 12).getTime();
    const a = setup({ storage, now: () => t });
    fireAll(a.target, 1, JS_ERROR_MAX_CODES + 3);
    a.off();
    expect(fulls(a.logs)).toBe(1);
    expect(JSON.parse(storage.data.get(JS_ERROR_KEY) ?? '{}')).toMatchObject({ d: '2026-10-30', f: 1 });
    const b = setup({ storage, now: () => t });
    offs.push(b.off);
    fireAll(b.target, JS_ERROR_MAX_CODES + 10, JS_ERROR_MAX_CODES + 15);
    expect(b.logs).toHaveLength(0);
    t = new Date(2026, 9, 31, 12).getTime();
    fireAll(b.target, 1, JS_ERROR_MAX_CODES + 2);
    expect(fulls(b.logs)).toBe(1);
    expect(b.logs).toHaveLength(JS_ERROR_MAX_CODES + 1);
  });

  it('存储读写都失败：退回这一页内存，照样只记一条', () => {
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    const s = setup({ storage: bad });
    offs.push(s.off);
    fireAll(s.target, 1, JS_ERROR_MAX_CODES + 10);
    expect(fulls(s.logs)).toBe(1);
    expect(s.logs).toHaveLength(JS_ERROR_MAX_CODES + 1);
  });
});
