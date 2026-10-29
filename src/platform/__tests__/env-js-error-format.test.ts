// 客户端错误日志 js_error（TC-B1-68）的审查建议 JSERR-sugg ⑤～⑨（10-30）：从 env-js-error.test.ts 拆出来（文件超过 300 行）
// ⑤ V8 格式的 stack 开头对不上就不用 stack；⑥ Firefox 函数名带“: 消息”不跳行；⑦ 加列号，code 改成“类型@文件名:行号:列号”；
// ⑧ 页面地址就是 /app/ 时记 index.html；⑨ 补测试：记满 50 个 code 后直接返回、读过 stack 再改 message
import { afterEach, describe, expect, it } from 'vitest';
import { JS_ERROR_DAILY_MAX, JS_ERROR_MAX_CODES, jsErrorCode, registerJsErrorLog } from '../env.ts';

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

function setup(over: { storage?: Pick<Storage, 'getItem' | 'setItem'> } = {}) {
  const target = new EventTarget();
  const logs: { act: string; code: string }[] = [];
  const off = registerJsErrorLog((act, f) => logs.push({ act, code: f.code }), {
    target, origin: ORIGIN, now: () => new Date(2026, 9, 30, 12).getTime(), storage: over.storage ?? memStorage(),
  });
  return { target, logs, off };
}

const offs: (() => void)[] = [];
afterEach(() => {
  while (offs.length) offs.pop()?.();
});

describe('JSERR-sugg ⑤～⑨', () => {
  const FAKE = `    at evil (${ORIGIN}/app/assets/fake.js:777:1)`;
  const REAL = `    at load (${ORIGIN}/app/assets/real.js:12:3)`;

  it('⑤⑨ 先读了 stack 再改 message：开头对不上，不用 stack，消息里伪造的同源帧不当成出错位置', () => {
    const err = new TypeError(`${PROBE}\n${FAKE}`);
    void err.stack;   // V8 在建对象时就定下了 stack 开头
    err.message = '换掉了';
    expect(jsErrorCode(err, {}, ORIGIN)).toBe('TypeError@unknown:0:0');
    // 同样的情形，手写 stack（不依赖运行环境的帧）
    const e2 = new TypeError('换掉了');
    e2.stack = `TypeError: ${PROBE}\n${FAKE}\n${REAL}`;
    expect(jsErrorCode(e2, {}, ORIGIN)).toBe('TypeError@unknown:0:0');
  });

  it('⑤ stack 被整个换掉（开头不是“名字: 消息”）、name 为空（开头直接是消息）：不用 stack', () => {
    const swapped = new TypeError('m');
    swapped.stack = `${FAKE}\n${REAL}`;
    expect(jsErrorCode(swapped, {}, ORIGIN)).toBe('TypeError@unknown:0:0');
    const other = new TypeError('m');
    other.stack = `TypeError: m 不一样\n${REAL}`;
    expect(jsErrorCode(other, {}, ORIGIN)).toBe('TypeError@unknown:0:0');
    const noName = Object.assign(new Error(`x\n${FAKE}`), { name: '' });
    noName.stack = `x\n${FAKE}\n${REAL}`;
    expect(jsErrorCode(noName, {}, ORIGIN)).toBe('Error@unknown:0:0');
    // message 不是字符串：也不信 stack
    const odd = Object.assign(new TypeError('m'), { message: 42 });
    odd.stack = `TypeError: 42\n${REAL}`;
    expect(jsErrorCode(odd, {}, ORIGIN)).toBe('TypeError@unknown:0:0');
  });

  it('⑤ 开头对得上：消息为空只有名字；自定义错误类在 super() 之后才改 name，开头还是 Error，照样用', () => {
    const empty = new TypeError('');
    empty.stack = `TypeError\n${REAL}`;
    expect(jsErrorCode(empty, {}, ORIGIN)).toBe('TypeError@real.js:12:3');
    class CacheClosedError extends Error {
      override name = 'CacheClosedError';
    }
    const c = new CacheClosedError(PROBE);
    c.stack = `Error: ${PROBE}\n${REAL}`;
    expect(jsErrorCode(c, {}, ORIGIN)).toBe('CacheClosedError@real.js:12:3');
    // 开头对上以后，紧跟着的不是换行（消息只是前缀）：不用
    const prefix = new TypeError('ab');
    prefix.stack = `TypeError: abc\n${REAL}`;
    expect(jsErrorCode(prefix, {}, ORIGIN)).toBe('TypeError@unknown:0:0');
  });

  it('⑥ Firefox：函数名里碰巧有“: 消息”，第一帧照样用，不跳行', () => {
    const err = new TypeError('boom');
    err.stack = `handle: boom@${ORIGIN}/app/assets/sync.js:10:4\n@${ORIGIN}/app/assets/main.js:1:1`;
    expect(jsErrorCode(err, {}, ORIGIN)).toBe('TypeError@sync.js:10:4');
  });

  it('⑦ 列号：ErrorEvent 的 colno；行号来自 stack 时列号也来自 stack；帧里没有列号记 0；不是正整数记 0', () => {
    const A = `${ORIGIN}/app/assets/a.js`;
    const e = new TypeError('m');
    e.stack = `TypeError: m\n    at ${A}:3:45`;
    expect(jsErrorCode(e, { filename: A, lineno: 1, colno: 9876 }, ORIGIN)).toBe('TypeError@a.js:1:9876');
    // lineno 给了 0：行号、列号都从 stack 取，不混用 ErrorEvent 的 colno
    expect(jsErrorCode(e, { filename: A, lineno: 0, colno: 9876 }, ORIGIN)).toBe('TypeError@a.js:3:45');
    expect(jsErrorCode(e, { filename: A, lineno: 2, colno: -1 }, ORIGIN)).toBe('TypeError@a.js:2:0');
    expect(jsErrorCode(e, { filename: A, lineno: 2, colno: 1.5 }, ORIGIN)).toBe('TypeError@a.js:2:0');
    const ff = new TypeError('m');
    ff.stack = `save@${A}:10`;
    expect(jsErrorCode(ff, {}, ORIGIN)).toBe('TypeError@a.js:10:0');
  });

  it('⑦ 同一行不同列算不同的 code，各自每天 5 条（计数按整串 code）', () => {
    const s = setup();
    offs.push(s.off);
    const fire = (colno: number): void => {
      const ev = errorEvent(new TypeError(PROBE), `${ORIGIN}/app/assets/a.js`, 1);
      Object.assign(ev, { colno });
      s.target.dispatchEvent(ev);
    };
    for (let i = 0; i < 6; i++) fire(100);
    for (let i = 0; i < 6; i++) fire(200);
    expect(s.logs.map((l) => l.code)).toEqual([...Array<string>(5).fill('TypeError@a.js:1:100'), ...Array<string>(5).fill('TypeError@a.js:1:200')]);
  });

  it('⑧ 页面地址就是 /app/（hash 路由、带 query）：记 index.html；别的路径仍记 unknown', () => {
    const e = new TypeError(PROBE);
    const at = (path: string): string => jsErrorCode(e, { filename: `${ORIGIN}${path}`, lineno: 2, colno: 5 }, ORIGIN);
    expect(at('/app/')).toBe('TypeError@index.html:2:5');
    expect(at(`/app/?from=${encodeURIComponent(PROBE)}#/notes/abc`)).toBe('TypeError@index.html:2:5');
    expect(at('/app')).toBe('TypeError@unknown:2:5');
    expect(at('/app/notes/')).toBe('TypeError@unknown:2:5');
  });

  it('⑨ 今天 50 个 code 都记满了：之后直接返回，不再读存储', () => {
    const storage = memStorage();
    let reads = 0;
    const counting = { getItem: (k: string) => (reads++, storage.getItem(k)), setItem: storage.setItem };
    const s = setup({ storage: counting });
    offs.push(s.off);
    const fire = (line: number): void => void s.target.dispatchEvent(errorEvent(new TypeError(PROBE), `${ORIGIN}/app/assets/a.js`, line));
    for (let line = 1; line <= JS_ERROR_MAX_CODES; line++) for (let i = 0; i < JS_ERROR_DAILY_MAX; i++) fire(line);
    expect(s.logs).toHaveLength(JS_ERROR_MAX_CODES * JS_ERROR_DAILY_MAX);
    fire(JS_ERROR_MAX_CODES + 1);   // 第 51 个 code：不记，并认定今天已满
    const before = reads;
    for (let i = 0; i < 10; i++) fire(JS_ERROR_MAX_CODES + 2 + i);
    expect(reads).toBe(before);
    expect(s.logs).toHaveLength(JS_ERROR_MAX_CODES * JS_ERROR_DAILY_MAX);
  });
});
