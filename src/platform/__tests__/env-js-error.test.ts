// 客户端错误日志（TC-B1-68；架构 6.1“客户端错误”、ADR-010）：
// act = js_error，code 只有“错误类型@文件名:行号”，不含消息原文和 URL 里的东西；同一个 code 每台设备每天只记 5 条
import { afterEach, describe, expect, it } from 'vitest';
import {
  JS_ERROR_ACT, JS_ERROR_DAILY_MAX, JS_ERROR_KEY, JS_ERROR_MAX_CODES, JS_ERROR_NAMES, jsErrorCode, registerJsErrorLog,
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
function rejection(reason: unknown): Event {
  const e = new Event('unhandledrejection');
  Object.assign(e, { reason });
  return e;
}

function setup(over: { now?: () => number; storage?: Pick<Storage, 'getItem' | 'setItem'> | null } = {}) {
  const target = new EventTarget();
  const logs: { act: string; code: string }[] = [];
  const storage = over.storage === undefined ? memStorage() : over.storage;
  const off = registerJsErrorLog((act, f) => logs.push({ act, code: f.code }), {
    target, origin: ORIGIN, now: over.now ?? (() => new Date(2026, 9, 30, 12).getTime()), storage,
  });
  return { target, logs, storage, off };
}

const offs: (() => void)[] = [];
afterEach(() => {
  while (offs.length) offs.pop()?.();
});

describe('TC-B1-68 js_error', () => {
  it('抛一个消息含“QA探针”的 TypeError，再抛 6 次：只记 5 条，code 只有类型@文件名:行号', () => {
    const storage = memStorage();
    const s = setup({ storage });
    offs.push(s.off);
    for (let i = 0; i < 7; i++) {
      const err = new TypeError(`${PROBE} 用户输入 hufan@example.com`);
      s.target.dispatchEvent(errorEvent(err, `${ORIGIN}/app/assets/sync.js?email=a%40b.com#${PROBE}`, 120));
    }
    expect(s.logs).toHaveLength(JS_ERROR_DAILY_MAX);
    for (const l of s.logs) expect(l).toEqual({ act: JS_ERROR_ACT, code: 'TypeError@sync.js:120' });
    // 日志和本机计数里都没有消息原文、query、hash
    const all = JSON.stringify(s.logs) + JSON.stringify([...storage.data.values()]);
    expect(all).not.toContain(PROBE);
    expect(all).not.toContain('example.com');
    expect(all).not.toContain('a%40b');
    expect(all).not.toContain('email');
  });

  it('unhandledrejection：从 stack 取文件名和行号；V8 stack 第一行的消息（哪怕带同源 URL）不当成出错位置', () => {
    const s = setup();
    offs.push(s.off);
    const err = new RangeError('x');
    err.stack = [
      `RangeError: ${PROBE} ${ORIGIN}/app/secret-path/abc.js:99`,
      `    at load (${ORIGIN}/app/assets/notes-Ab12.js?v=1:88:13)`,
      `    at ${ORIGIN}/app/assets/main.js:5:1`,
    ].join('\n');
    s.target.dispatchEvent(rejection(err));
    expect(s.logs).toEqual([{ act: 'js_error', code: 'RangeError@notes-Ab12.js:88' }]);
  });

  it('Safari / Firefox 的 stack 格式（fn@url:行:列）', () => {
    const err = new TypeError(PROBE);
    err.stack = `save@${ORIGIN}/app/assets/sync.js:120:9\n@${ORIGIN}/app/assets/main.js:1:1`;
    expect(jsErrorCode(err, {}, ORIGIN)).toBe('TypeError@sync.js:120');
  });

  it('reject 的不是 Error（字符串、对象）：类型记 NonError，内容一律不记', () => {
    const s = setup();
    offs.push(s.off);
    s.target.dispatchEvent(rejection(`${PROBE} 原话`));
    s.target.dispatchEvent(rejection({ message: PROBE, stack: `at ${ORIGIN}/app/a.js:1:1` }));
    expect(s.logs.map((l) => l.code)).toEqual(['NonError@unknown:0', 'NonError@unknown:0']);
    expect(JSON.stringify(s.logs)).not.toContain(PROBE);
  });

  it('错误类型：只认白名单（审查 S1），自定义的怪名字记 Error', () => {
    const A = `${ORIGIN}/app/assets/a.js`;
    const named = (name: string): Error => Object.assign(new Error('m'), { name });
    expect(jsErrorCode(named(`${PROBE}Error`), { filename: A, lineno: 3 }, ORIGIN)).toBe('Error@a.js:3');
    expect(jsErrorCode(named('QuotaExceededError'), { filename: A, lineno: 3 }, ORIGIN)).toBe('QuotaExceededError@a.js:3');
    expect(jsErrorCode(new DOMException('m', 'NotAllowedError'), { filename: A, lineno: 3 }, ORIGIN)).toBe('NotAllowedError@a.js:3');
    const long = named('A'.repeat(40) + 'Error');
    Object.defineProperty(long, 'stack', { value: undefined });
    expect(jsErrorCode(long, {}, ORIGIN)).toBe('Error@unknown:0');
  });

  it.each([
    'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError', 'AggregateError',
    'QuotaExceededError', 'NotAllowedError', 'AbortError', 'NotFoundError', 'InvalidStateError', 'SecurityError',
    'NetworkError', 'DataError', 'TimeoutError', 'NotSupportedError', 'VersionError', 'UnknownError', 'ConstraintError',
    'TransactionInactiveError', 'ReadOnlyError', 'DataCloneError',
    'CacheClosedError', 'OutboxRejectError', 'ObjStoreError',
  ])('白名单里的名字原样记：%s', (name) => {
    expect(JS_ERROR_NAMES.has(name)).toBe(true);
    const e = Object.assign(new Error('m'), { name });
    expect(jsErrorCode(e, { filename: `${ORIGIN}/app/assets/a.js`, lineno: 3 }, ORIGIN)).toBe(`${name}@a.js:3`);
  });

  it.each([
    // 形如 XxxError / XxxException、但不在白名单里：以前会照记，驼峰名里可能拼进用户内容
    'HufanAtExampleComError', 'MyDiaryTitleSecretError', 'SomethingException', 'DOMException', 'error', 'TYPEERROR',
    'TypeError ', ' TypeError', 'TypeError\n', '',
  ])('白名单外的名字记 Error：%j', (name) => {
    const e = Object.assign(new Error('m'), { name });
    expect(jsErrorCode(e, { filename: `${ORIGIN}/app/assets/a.js`, lineno: 3 }, ORIGIN)).toBe('Error@a.js:3');
  });

  it('本项目自定义的错误（name 写在类里）：按类名记', () => {
    class CacheClosedError extends Error {
      override name = 'CacheClosedError';
    }
    class OutboxRejectError extends Error {
      override name = 'OutboxRejectError';
    }
    class ObjStoreError extends Error {
      constructor(m: string) {
        super(m);
        this.name = 'ObjStoreError';
      }
    }
    class NotListedError extends Error {
      override name = 'NotListedError';
    }
    const at = { filename: `${ORIGIN}/app/assets/sync-Ab12.js`, lineno: 9 };
    expect(jsErrorCode(new CacheClosedError(PROBE), at, ORIGIN)).toBe('CacheClosedError@sync-Ab12.js:9');
    expect(jsErrorCode(new OutboxRejectError(PROBE), at, ORIGIN)).toBe('OutboxRejectError@sync-Ab12.js:9');
    expect(jsErrorCode(new ObjStoreError(PROBE), at, ORIGIN)).toBe('ObjStoreError@sync-Ab12.js:9');
    expect(jsErrorCode(new NotListedError(PROBE), at, ORIGIN)).toBe('Error@sync-Ab12.js:9');
  });

  it('多行消息（审查 S2）：stack 开头消息有几行就跳过几行，消息里的 “at 同源URL” 不当成帧', () => {
    const s = setup();
    offs.push(s.off);
    const msg = [
      `${PROBE} 第一行`,
      `    at evil (${ORIGIN}/app/assets/fake-${PROBE.length}.js:777:1)`,
      `    at ${ORIGIN}/app/assets/fake2.js:666:1`,
    ].join('\n');
    const err = new TypeError(msg);
    err.stack = [`TypeError: ${msg}`, `    at load (${ORIGIN}/app/assets/notes-Ab12.js:88:13)`, `    at ${ORIGIN}/app/assets/main.js:5:1`].join('\n');
    s.target.dispatchEvent(rejection(err));
    expect(s.logs).toEqual([{ act: 'js_error', code: 'TypeError@notes-Ab12.js:88' }]);
  });

  it('多行消息以换行开头、或只有消息没有帧：不把消息当成帧', () => {
    const msg = `\n    at ${ORIGIN}/app/assets/fake.js:777:1`;
    const err = new TypeError(msg);
    err.stack = `TypeError: ${msg}\n    at ${ORIGIN}/app/assets/real.js:12:3`;
    expect(jsErrorCode(err, {}, ORIGIN)).toBe('TypeError@real.js:12');
    const only = new TypeError(msg);
    only.stack = `TypeError: ${msg}`;
    expect(jsErrorCode(only, {}, ORIGIN)).toBe('TypeError@unknown:0');
  });

  it('Safari / Firefox 的 stack 不带消息：不跳过第一帧（哪怕帧里碰巧含有消息文字）', () => {
    const err = new TypeError('sync');
    err.stack = `save@${ORIGIN}/app/assets/sync.js:120:9\n@${ORIGIN}/app/assets/main.js:1:1`;
    expect(jsErrorCode(err, {}, ORIGIN)).toBe('TypeError@sync.js:120');
  });

  it('文件名：同源的只认 /app/assets/ 下和 /app/index.html，别的路径记 unknown（审查 S3）', () => {
    const e = new TypeError(PROBE);
    const at = (path: string): string => jsErrorCode(e, { filename: `${ORIGIN}${path}`, lineno: 2 }, ORIGIN);
    expect(at('/app/assets/main-Ab12.js')).toBe('TypeError@main-Ab12.js:2');
    expect(at('/app/assets/main-Ab12.js?v=1#x')).toBe('TypeError@main-Ab12.js:2');
    expect(at('/app/index.html')).toBe('TypeError@index.html:2');
    // 不在 assets 下（名字本身干净也不认）
    expect(at('/a.js')).toBe('TypeError@unknown:2');
    expect(at('/app/a.js')).toBe('TypeError@unknown:2');
    expect(at('/app/sw.js')).toBe('TypeError@unknown:2');
    expect(at('/index.html')).toBe('TypeError@unknown:2');
    expect(at('/app/notes/index.html')).toBe('TypeError@unknown:2');
    expect(at(`/app/${encodeURIComponent('hufan@example.com')}/assets/a.js`)).toBe('TypeError@unknown:2');
    // assets 下再分子目录、或者用 .. 绕：都不认（URL 会先把 .. 规整掉）
    expect(at('/app/assets/sub/a.js')).toBe('TypeError@unknown:2');
    expect(at('/app/assets/../secret.js')).toBe('TypeError@unknown:2');
    expect(at('/app/assets/')).toBe('TypeError@unknown:2');
    expect(at('/APP/ASSETS/a.js')).toBe('TypeError@unknown:2');
  });

  it('文件名：别的来源记 ext，名字不干净（含中文、空格、太长、不是脚本）记 unknown，路径和域名不记', () => {
    const e = new TypeError(PROBE);
    expect(jsErrorCode(e, { filename: 'chrome-extension://abcdef/content.js', lineno: 2 }, ORIGIN)).toBe('TypeError@ext:2');
    expect(jsErrorCode(e, { filename: 'https://evil.example/x.js', lineno: 2 }, ORIGIN)).toBe('TypeError@ext:2');
    expect(jsErrorCode(e, { filename: `${ORIGIN}/app/assets/${encodeURIComponent(PROBE)}.js`, lineno: 2 }, ORIGIN)).toBe('TypeError@unknown:2');
    expect(jsErrorCode(e, { filename: `${ORIGIN}/app/notes/123e4567`, lineno: 2 }, ORIGIN)).toBe('TypeError@unknown:2');
    expect(jsErrorCode(e, { filename: `${ORIGIN}/app/assets/${'a'.repeat(50)}.js`, lineno: 2 }, ORIGIN)).toBe('TypeError@unknown:2');
    expect(jsErrorCode(e, { filename: 'not a url', lineno: 2 }, ORIGIN)).toBe('TypeError@unknown:2');
    expect(jsErrorCode(e, { filename: `${ORIGIN}/app/index.html`, lineno: 2 }, ORIGIN)).toBe('TypeError@index.html:2');
  });

  it('跨源脚本的 “Script error.”（没有 error 对象、没有文件名）：Error@unknown:0', () => {
    const s = setup();
    offs.push(s.off);
    s.target.dispatchEvent(errorEvent(null, '', 0));
    expect(s.logs).toEqual([{ act: 'js_error', code: 'Error@unknown:0' }]);
  });

  it('code 最长 64 字', () => {
    // 白名单里最长的名字 + 最长的文件名 + 7 位行号 = 76 字，截到 64
    const e = new DOMException('m', 'TransactionInactiveError');
    const code = jsErrorCode(e, { filename: `${ORIGIN}/app/assets/${'b'.repeat(37)}.js`, lineno: 1234567 }, ORIGIN);
    expect(code).toBe(`TransactionInactiveError@${'b'.repeat(37)}.js:1234567`.slice(0, 64));
    expect(code).toHaveLength(64);
  });

  it('每天按本机日期算：第二天同一个 code 重新可以记 5 条；不同的 code 各算各的', () => {
    let t = new Date(2026, 9, 30, 12).getTime();
    const s = setup({ now: () => t });
    offs.push(s.off);
    const fire = (file: string): void => void s.target.dispatchEvent(errorEvent(new TypeError(PROBE), `${ORIGIN}/app/assets/${file}`, 1));
    for (let i = 0; i < 6; i++) fire('a.js');
    for (let i = 0; i < 2; i++) fire('b.js');
    expect(s.logs.map((l) => l.code)).toEqual([...Array<string>(5).fill('TypeError@a.js:1'), 'TypeError@b.js:1', 'TypeError@b.js:1']);
    t += 86_400_000;
    fire('a.js');
    expect(s.logs).toHaveLength(8);
  });

  it('计数存在本机：刷新页面（重新注册）以后同一天也不超过 5 条', () => {
    const storage = memStorage();
    const a = setup({ storage });
    for (let i = 0; i < 3; i++) a.target.dispatchEvent(rejection(new TypeError(PROBE)));
    a.off();
    const b = setup({ storage });
    offs.push(b.off);
    for (let i = 0; i < 5; i++) b.target.dispatchEvent(rejection(new TypeError(PROBE)));
    expect(a.logs.length + b.logs.length).toBe(JS_ERROR_DAILY_MAX);
    expect(storage.data.has(JS_ERROR_KEY)).toBe(true);
  });

  it('一天最多记 50 个不同的 code，再多的不记', () => {
    const s = setup();
    offs.push(s.off);
    for (let i = 1; i <= JS_ERROR_MAX_CODES + 5; i++) s.target.dispatchEvent(errorEvent(new TypeError(PROBE), `${ORIGIN}/app/assets/a.js`, i));
    expect(s.logs).toHaveLength(JS_ERROR_MAX_CODES);
  });

  it('localStorage 读写抛错：退回内存计数，照样每天 5 条，不抛', () => {
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    const s = setup({ storage: bad });
    offs.push(s.off);
    for (let i = 0; i < 7; i++) s.target.dispatchEvent(rejection(new TypeError(PROBE)));
    expect(s.logs).toHaveLength(5);
  });

  it.each([
    ['当天', '2026-10-30', 4],
    ['前一天', '2026-10-29', 5],
  ])('存储读得出、写不进（已有%s的计数）：照样每天最多 5 条（审查 M1）', (_label, d, want) => {
    // 错误都在 mk 这一行建，code 一样；先算出这个 code，在存储里预置它的计数
    const mk = (): TypeError => new TypeError(PROBE);
    const old = JSON.stringify({ d, c: { [jsErrorCode(mk(), {}, ORIGIN)]: 1 } });
    const full = { getItem: () => old, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
    const s = setup({ storage: full, now: () => new Date(2026, 9, 30, 12).getTime() });
    offs.push(s.off);
    for (let i = 0; i < 7; i++) s.target.dispatchEvent(rejection(mk()));
    expect(s.logs).toHaveLength(want);
  });

  it('超长单行 stack：很快算完（审查 S4）', () => {
    const e = new TypeError(PROBE);
    e.stack = `TypeError: x\n${'a://b'.repeat(10_000)}`;
    const s = setup();
    offs.push(s.off);
    const t0 = Date.now();
    s.target.dispatchEvent(rejection(e));
    expect(Date.now() - t0).toBeLessThan(500);
    expect(s.logs).toHaveLength(1);
  });

  it('记日志的函数抛错：吞掉，不影响下一次', () => {
    const target = new EventTarget();
    let calls = 0;
    const off = registerJsErrorLog(() => {
      calls++;
      throw new Error('sink down');
    }, { target, origin: ORIGIN, storage: null });
    offs.push(off);
    target.dispatchEvent(rejection(new TypeError(PROBE)));
    target.dispatchEvent(rejection(new TypeError(PROBE)));
    expect(calls).toBe(2);
  });

  it('默认挂在 window 上（addEventListener，不占 window.onerror 属性）；注销后不再记', () => {
    const logs: string[] = [];
    const before = window.onerror;
    const off = registerJsErrorLog((_act, f) => logs.push(f.code), { storage: null });
    expect(window.onerror).toBe(before);
    window.dispatchEvent(rejection(new TypeError(PROBE)));
    off();
    window.dispatchEvent(rejection(new TypeError(PROBE)));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^TypeError@/);
    expect(logs[0]).not.toContain(PROBE);
  });
});
