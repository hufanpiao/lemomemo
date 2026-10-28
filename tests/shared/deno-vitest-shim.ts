// Deno 跑 tests/shared 用的最小 vitest 替身（架构 2.5：shared 的测试 Node 和 Deno 都跑）
// deno.json 的 import map 把 'vitest' 指到这里；只实现 shared 测试用到的几个匹配器，用多了这里会报“没实现”
// 本文件只给 Deno 用，不进 tsconfig.node.json
declare const Deno: {
  test(name: string, fn: () => void | Promise<void>): void;
  test(def: { name: string; ignore: boolean; fn: () => void }): void;
};

const stack: string[] = [];

export function describe(name: string, fn: () => void): void {
  stack.push(name);
  try {
    fn();
  } finally {
    stack.pop();
  }
}

export function it(name: string, a: unknown, b?: unknown): void {
  const fn = (typeof a === 'function' ? a : b) as () => void | Promise<void>;
  Deno.test([...stack, name].join(' > '), fn);
}
/** 报告里显示“ignored”（跳过），不是“通过”（QA D-10） */
it.skip = (name: string, _a?: unknown, _b?: unknown): void => {
  Deno.test({ name: [...stack, name].join(' > '), ignore: true, fn: () => {} });
};
export const test = it;

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const show = (v: unknown): string => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

function matchers(actual: unknown, negate: boolean, label?: string) {
  const check = (ok: boolean, what: string) => {
    if (ok === negate) throw new Error(`${label ? `${label}：` : ''}expected ${show(actual)} ${negate ? 'not ' : ''}${what}`);
  };
  return {
    toBe: (e: unknown) => check(Object.is(actual, e), `to be ${show(e)}`),
    toEqual: (e: unknown) => check(same(actual, e), `to equal ${show(e)}`),
    toStrictEqual: (e: unknown) => check(same(actual, e), `to equal ${show(e)}`),
    toBeNull: () => check(actual === null, 'to be null'),
    toBeGreaterThan: (e: number) => check((actual as number) > e, `to be > ${e}`),
    toBeLessThan: (e: number) => check((actual as number) < e, `to be < ${e}`),
    toHaveLength: (n: number) => check((actual as { length: number }).length === n, `to have length ${n}`),
    toContain: (e: unknown) =>
      check(
        typeof actual === 'string' ? actual.includes(e as string) : (actual as unknown[]).some((x) => Object.is(x, e)),
        `to contain ${show(e)}`,
      ),
    toMatch: (re: RegExp) => check(re.test(actual as string), `to match ${re}`),
    toThrow: (msg?: string | RegExp) => {
      let threw = false;
      let text = '';
      try {
        (actual as () => unknown)();
      } catch (e) {
        threw = true;
        text = e instanceof Error ? e.message : String(e);
      }
      const ok = threw && (msg === undefined || (typeof msg === 'string' ? text.includes(msg) : msg.test(text)));
      check(ok, `to throw ${msg ?? ''}`);
    },
  };
}

export function expect(actual: unknown, label?: string) {
  return { ...matchers(actual, false, label), not: matchers(actual, true, label) };
}
