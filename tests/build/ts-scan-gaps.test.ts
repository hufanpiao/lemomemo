// tests/build/ts-scan.ts 扫描器的正反例续篇（FN-cov-gaps 余项，10-30）：控制语句条件 ) 之后的正则、经变量间接调 skip。
// 末尾另有 ts-scan-core 的 matchOpen、enclosingOpen 直接单测（OPS-logcalls-gap 用到，11 批）。
// 从 ts-scan.test.ts 分出来免超 max-lines；原则同那边：认不出的写法宁可当“没覆盖”，不能当“覆盖了”。
import { describe, expect, it } from 'vitest';
import { assertsLiteral, references, testCases, type TestCase } from './ts-scan.ts';
import { enclosingOpen, matchClose, matchOpen, scan } from './ts-scan-core.ts';

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

  it('正例：for await (…) 的条件 ) 之后的 / 是正则（在 ( 处 prevWord 是 await、它前一个词是 for；TSSCAN 复审建议，10-30）', () => {
    for (const head of ['for await (const x of xs)', 'for  await\n  (const x of xs)', 'for /* c */ await (const x of xs)']) {
      expect(references(`${head} /'/.test(s); requireActiveUser(req);`, 'requireActiveUser'), head).toBe(true);
      expect(references(`${head} /'/.test(s); // requireActiveUser(req)`, 'requireActiveUser'), head).toBe(false);
    }
    expect(assertsLiteral(inIt(`for await (const x of xs) /a'b/.test(s);\n${E}`), AD)).toBe(true);
    // 已知认不出（不修，TSSCAN 复审建议）：尾点数字 “1.” 换行接 if（const n = 1.↵if (x) /re/.test(s)）——扫描器把 if 当成
    // “.” 后面的属性名（同 obj.if(k)），条件 ) 之后的 / 当除号，正则内容不抹、后面的引号可能被当成字符串开头；
    // 两个方向都可能认错（漏认，或把正则里的文字当成调用），仓库里现在没有这种写法，先记在这里
  });

  it('反例：await 前面不是 for（return await (x) / 2、obj.for await 不成立的写法、x.await (k)）照旧是除号', () => {
    for (const head of ['return await (x)', 'const v = await (x)', 'const v = x.await(k)', 'const v = forx await (k)', 'const v = o.for await (k)']) {
      expect(references(`${head} / 2; requireActiveUser(req); const m = q / 3;`, 'requireActiveUser'), head).toBe(true);
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

describe('ts-scan-core：matchOpen（反向配对）、enclosingOpen（最内层开括号）', () => {
  /** 在骨架里找第 n 个（从 0 数）ch 的下标 */
  const nth = (s: string, ch: string, n = 0) => { let k = -1; for (let i = 0; i <= n; i++) k = s.indexOf(ch, k + 1); return k; };

  it('matchOpen：嵌套 ( [ { 配对，和 matchClose 互为反向', () => {
    const { skel } = scan('f(a, [b, { c: g(d) }], (e))');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
      const o = skel.indexOf(open);
      const c = matchClose(skel, o);
      expect(skel[c]).toBe(close);
      expect(matchOpen(skel, c)).toBe(o);
    }
    expect(matchOpen(skel, skel.length - 1)).toBe(1);   // 最外层 ) 回到 f 后面的 (
    expect(matchOpen(skel, nth(skel, ')', 0))).toBe(nth(skel, '(', 1));   // g(d) 的 )
  });

  it('matchOpen：字符串、模板字面部分、注释、正则里的括号骨架已去掉，不参与配对', () => {
    const code = "f(')', \"(\", `[${x}]`, /\\(/, /* ( */ y) // )";
    const { skel } = scan(code);
    const close = nth(skel, ')', skel.split(')').length - 2);   // 骨架里最后一个 )：f 的闭括号
    expect(close).toBe(code.lastIndexOf('y') + 1);
    expect(matchOpen(skel, close)).toBe(1);
    // 模板里 ${x} 是代码：它的 { } 留在骨架里，照样配对
    const lb = skel.indexOf('{');
    expect(matchOpen(skel, matchClose(skel, lb))).toBe(lb);
  });

  it('matchOpen：找不到回 -1（多出来的闭括号、括号种类不配、起点不是闭括号也不配）', () => {
    expect(matchOpen(scan('a)').skel, 1)).toBe(-1);
    expect(matchOpen(scan('[a)').skel, 2)).toBe(-1);
    expect(matchOpen(scan('(a]').skel, 2)).toBe(-1);
    expect(matchOpen(scan("'('").skel, 1)).toBe(-1);   // 字符串里的 ( 在骨架里是空格
  });

  it('enclosingOpen：最内层开括号；跳过已配对的兄弟括号；顶层回 -1', () => {
    const code = 'f(a, g(b), [c, { d: e }])';
    const { skel } = scan(code);
    expect(enclosingOpen(skel, code.indexOf('a'))).toBe(1);
    expect(enclosingOpen(skel, code.indexOf('b'))).toBe(code.indexOf('g') + 1);
    expect(enclosingOpen(skel, code.indexOf('c'))).toBe(code.indexOf('['));   // 前面的 g(b) 已配对，跳过
    expect(enclosingOpen(skel, code.indexOf('e'))).toBe(code.indexOf('{'));
    expect(enclosingOpen(skel, 0)).toBe(-1);
    expect(enclosingOpen(scan('a; b').skel, 3)).toBe(-1);
  });

  it('enclosingOpen：字符串、注释里的括号不算（骨架已去掉）', () => {
    const code = "f(x, ')', /* ( */ \"[\", y)";
    const { skel } = scan(code);
    expect(enclosingOpen(skel, code.indexOf('y'))).toBe(1);
    expect(enclosingOpen(scan("'(' + z").skel, 6)).toBe(-1);
    expect(enclosingOpen(scan('// (\nz').skel, 5)).toBe(-1);
  });
});
