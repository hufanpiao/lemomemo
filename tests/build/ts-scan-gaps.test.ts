// tests/build/ts-scan.ts 扫描器的正反例续篇（FN-cov-gaps 余项，10-30）：控制语句条件 ) 之后的正则、经变量间接调 skip。
// 从 ts-scan.test.ts 分出来免超 max-lines；原则同那边：认不出的写法宁可当“没覆盖”，不能当“覆盖了”。
import { describe, expect, it } from 'vitest';
import { assertsLiteral, references, testCases, type TestCase } from './ts-scan.ts';

const AD = 'account_disabled';
const one = (code: string) => testCases(code)[0] as TestCase;
const inIt = (body: string) => one(`it('t', async () => {\n${body}\n});`);
const live = (code: string) => testCases(code).filter((t) => t.skipped === null).map((t) => t.title);

describe('FN-cov-gaps 余项（10-30）：控制语句条件 ) 之后的正则、经变量间接调 skip', () => {
  const E = "expect(r).toEqual({ error: 'account_disabled' });";
  const why = (code: string) => testCases(code)[0]?.skipped ?? null;

  it('正例：if / while / for / with 的条件 ) 之后的 / 是正则（正则里的引号、/ 不打乱后面的扫描）', () => {
    for (const head of ['if (x)', 'while (x)', 'for (;;)', 'with (o)', 'if ((a) && f(b))', 'if (x)\n ']) {
      expect(references(`${head} /'/.test(s); requireActiveUser(req);`, 'requireActiveUser'), head).toBe(true);
      // 正则当成除号的话，后面那段会被当成正则吞掉或打乱：注释里的调用照样不算
      expect(references(`${head} /'/.test(s); // requireActiveUser(req)`, 'requireActiveUser'), head).toBe(false);
    }
    // 用例里的写法：if (x) /re/.test(s) 后面的断言照常认得出
    expect(assertsLiteral(inIt(`if (x) /a'b/.test(s);\n${E}`), AD)).toBe(true);
  });

  it('反例：普通括号、函数调用、下标之后的 / 照旧是除号', () => {
    expect(references("const q = (a) / 2; const s = 'x/'; requireActiveUser(req);", 'requireActiveUser')).toBe(true);
    expect(references("const q = f(a) / g(b) / 2; const s = 'x/'; requireActiveUser(req);", 'requireActiveUser')).toBe(true);
    expect(references("if (a) { const q = (b) / 2; } const s = 'x/'; requireActiveUser(req);", 'requireActiveUser')).toBe(true);
    expect(references("const q = verify(a) / 2; const s = 'x/'; requireActiveUser(req);", 'requireActiveUser')).toBe(true);
    // ifx、forEach 这类名字只是带 if / for 的，不当控制语句
    expect(references("const q = ifx(a) / 2; const s = 'x/'; requireActiveUser(req);", 'requireActiveUser')).toBe(true);
    expect(references("const q = forEach(a) / 2; const s = 'x/'; requireActiveUser(req);", 'requireActiveUser')).toBe(true);
    // 控制语句条件之后、语句里的除号照旧是除号
    expect(references("for (;;) z = a / b / c; const s = 'x/'; requireActiveUser(req);", 'requireActiveUser')).toBe(true);
    expect(references("while (f(a)) n = n / 2; const s = 'x/'; requireActiveUser(req);", 'requireActiveUser')).toBe(true);
  });

  it('反例：关键字前面是 . 或 ?.（Symbol.for(k)、obj.if(k)、a?.while(k)、跨行 .for(k)）是方法调用，之后的 / 是除号（TSSCAN-sugg，10-30）', () => {
    // 当成正则开头的话，除号到下一个 / 之间的 expect 会被整段抹掉
    expect(assertsLiteral(inIt(`const n = Symbol.for('k') / 2; ${E} const m = q / 3;`), AD)).toBe(true);
    for (const head of ['Symbol.for(k)', 'obj.if(k)', 'a?.while(k)', 'x.with(k)', 'obj\n  .for(k)', 'obj.\n for(k)', 'a?.\n  if(k)']) {
      expect(references(`const n = ${head} / 2; requireActiveUser(req); const m = q / 3;`, 'requireActiveUser'), head).toBe(true);
    }
  });

  it('正例：经变量间接调 skip（别名赋值、this.skip、解构改名、参数解构改名、skip.call / apply）都算跳过', () => {
    expect(why(`it('X', async (ctx) => { const s = ctx.skip; s(); ${E} });`)).toBe('运行时跳过：经变量 s 调了 skip');
    expect(why(`it('X', async (ctx) => { let s; s = ctx.skip; if (!db) s('没有库'); ${E} });`)).toBe('运行时跳过：经变量 s 调了 skip');
    expect(why(`it('X', function () { const s = this.skip; s(); ${E} });`)).toBe('运行时跳过：经变量 s 调了 skip');
    expect(why(`it('X', async (ctx) => { const { skip: s } = ctx; s(); ${E} });`)).toBe('运行时跳过：经变量 s 调了 skip');
    expect(why(`it('X', async ({ skip: bail }) => { bail(); ${E} });`)).toBe('运行时跳过：经变量 bail 调了 skip');
    expect(why(`it('X', async (ctx) => { const s: () => void = ctx.skip; s(); ${E} });`)).toBe('运行时跳过：经变量 s 调了 skip');
    expect(why(`it('X', async (ctx) => { ctx.skip.call(ctx); ${E} });`)).toBe('运行时跳过：回调里调了 skip.call(…)');
    expect(why(`it('X', async (ctx) => { ctx.skip.apply(ctx, []); ${E} });`)).toBe('运行时跳过：回调里调了 skip.apply(…)');
    expect(live(`it('X', async (ctx) => { const s = ctx.skip; s(); ${E} });`)).toEqual([]);
  });

  it('反例：只取了别名没调、bind 出口、死分支里调、别名同名的别的调用（.s()）、skipped 之类名字', () => {
    for (const body of [
      `const s = ctx.skip;\n${E}`,
      `const page = q.skip.bind(q);\npage(2);\n${E}`,
      `const s = ctx.skip;\nif (false) { s(); }\n${E}`,
      `const s = ctx.skip;\nobj.s();\n${E}`,
      `const s = ctx.skipped;\ns();\n${E}`,
      `const { skipIf: s } = ctx;\ns();\n${E}`,
      `const n = a == ctx.skip;\nn();\n${E}`,
      `const s = 'ctx.skip';\ns();\n${E}`,
    ]) {
      expect(why(`it('X', async (ctx) => {\n${body}\n});`), body).toBeNull();
    }
  });
});
