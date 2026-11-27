// tests/build/ts-scan.ts 的正反例（TC-B1-10、TC-B1-109 覆盖核对用的扫描器；审查探针里的写法逐条进来）。
// 原则：认不出的写法宁可当“没覆盖”，不能当“覆盖了”。
import { describe, expect, it } from 'vitest';
import { assertsLiteral, hasAssertion, references, scan, testCases, tomlFunctions, verifyJwtTrue, type TestCase } from './ts-scan.ts';

const AD = 'account_disabled';
const one = (code: string) => testCases(code)[0] as TestCase;
const inIt = (body: string) => one(`it('t', async () => {\n${body}\n});`);
const live = (code: string) => testCases(code).filter((t) => t.skipped === null).map((t) => t.title);

describe('扫描：注释、字符串、模板、正则', () => {
  it('注释里的用例、断言不算；字符串里的 // 不当注释；正则字面量里的引号不打乱', () => {
    const code = [
      "// it('注释里的用例', () => { expect(x).toEqual({ error: 'account_disabled' }); });",
      "/* it('块注释里的', () => {}); */",
      "const re = /it\\('x'/;",
      "it('真用例 https://x/y', () => {",
      "  // expect(r).toEqual({ error: 'account_disabled' });",
      '  expect(1).toBe(1);',
      '});',
      "it.skip('跳过的', () => { expect(r).toEqual({ error: 'account_disabled' }); });",
    ].join('\n');
    expect(testCases(code).map((t) => t.title)).toEqual(['真用例 https://x/y']);
    expect(assertsLiteral(one(code), AD)).toBe(false);
  });

  it('/ 是除号还是正则：) 后、后置 ++ -- 后是除号；else、await、yield、void、throw、new、delete、typeof 后是正则', () => {
    // 除号当成正则的话，正则会吞到下一个 /，后面的引号把 requireActiveUser 包进“字符串”
    expect(references("const r = (a) / 2; const s = 'x/'; requireActiveUser(req);", 'requireActiveUser')).toBe(true);
    expect(references("let i = 0; const q = i++ / 2; const s = \"x/'\"; requireActiveUser(req);", 'requireActiveUser')).toBe(true);
    expect(references("let i = 0; const q = i-- / 2; const s = 'x/'; requireActiveUser(req);", 'requireActiveUser')).toBe(true);
    expect(scan("const s = 'abc';").skel).toBe("const s = '   ';");
    for (const kw of ['else', 'await', 'yield', 'void', 'throw', 'new', 'delete', 'typeof']) {
      expect(references(`if (a) {} ${kw} /'/.test(b); requireActiveUser(req);`, 'requireActiveUser'), kw).toBe(true);
    }
    expect(references("if (a) {} else /'/.test(b); // requireActiveUser(req)", 'requireActiveUser')).toBe(false);
  });

  it('模板：字面部分遮住，${…} 里照代码扫（里面的调用算、里面的 } 字符串不打乱）', () => {
    expect(references('const s = `${requireActiveUser(req)}`;', 'requireActiveUser')).toBe(true);
    expect(references('const s = `requireActiveUser(req)`;', 'requireActiveUser')).toBe(false);
    expect(references("const s = `${ x ? '}' : '' }`; requireActiveUser(req);", 'requireActiveUser')).toBe(true);
    expect(references("const s = `${ x ? '}' : '' } requireActiveUser`;", 'requireActiveUser')).toBe(false);
  });
});

describe('引用：import 别名、命名空间、只赋值也算；import 语句本身、注释、字符串不算', () => {
  it('各种写法', () => {
    expect(references("import { requireActiveUser as rau } from '../_shared/auth.ts'; await rau(req, admin);", 'requireActiveUser')).toBe(true);
    expect(references("import * as auth from '../_shared/auth.ts'; await auth.requireActiveUser(req, admin);", 'requireActiveUser')).toBe(true);
    expect(references('const f = requireActiveUser; await f(req, admin);', 'requireActiveUser')).toBe(true);
    expect(references("import { requireActiveUser } from '../_shared/auth.ts';\nDeno.serve(() => new Response());", 'requireActiveUser')).toBe(false);
    expect(references("const s = 'requireActiveUser(req)';", 'requireActiveUser')).toBe(false);
    expect(references('await requireActiveUserX(req);', 'requireActiveUser')).toBe(false);
    // 已知宽松点：只引用不调用也算
    expect(references("import { requireActiveUser } from '../_shared/auth.ts';\nexport const _keep = requireActiveUser;", 'requireActiveUser')).toBe(true);
  });

  it('不写分号：import / export … from 不跨语句吞代码', () => {
    const noSemi = "export function a() { return 1 }\nexport async function h(req) { await requireActiveUser(req, admin) }\nexport { x } from './y.ts'";
    expect(references(noSemi, 'requireActiveUser')).toBe(true);
    expect(references("import { a } from './a.ts'\nimport { b } from './b.ts'\nawait requireActiveUser(req, admin)", 'requireActiveUser')).toBe(true);
    expect(references("export const k = 1\nconst v = requireActiveUser\nexport { y } from './y.ts'", 'requireActiveUser')).toBe(true);
  });
});

describe('用例：会不会跑', () => {
  it('describe.skip、skipIf(…)、todo、xdescribe、describe(名, { skip: true }, …) 里的 it 不算；普通 describe 里的算', () => {
    const t = "it('X', () => { expect(r).toEqual({ error: 'account_disabled' }); });";
    for (const d of [
      "describe.skip('d', () => {", "describe.skipIf(!db)('d', () => {", "describe.skipIf(false)('d', () => {", "describe.todo('d', () => {",
      "xdescribe('d', () => {", "describe('d', { skip: true }, () => {", "describe('d', { skip: true, timeout: 5 }, () => {",
      "describe.concurrent.skip('d', () => {", "describe.sequential.skip('d', () => {", "describe.skip.each([1])('d %s', () => {",
      "describe.todo.each([1])('d %s', () => {", "suite.skip('d', () => {", "suite.concurrent.todo('d', () => {",
      "describe.runIf(db)('d', () => {", "describe.runIf(false)('d', () => {", "describe.concurrent.runIf(!ci)('d', () => {",
      "describe.skip('o', () => { describe('d', () => {",
    ]) {
      // 最后一种是外层 describe.skip 里再套一层普通 describe，要多收一个 });
      expect(live(`${d} ${t} });${d.startsWith("describe.skip('o'") ? ' });' : ''}`), d).toEqual([]);
    }
    expect(live(`describe('d', () => { ${t} });`)).toEqual(['X']);
    expect(live(`suite('d', () => { ${t} });`)).toEqual(['X']);
    expect(live(`describe.each([1])('d %s', () => { ${t} });`)).toEqual(['X']);
    expect(live(`describe.concurrent('d', () => { ${t} });`)).toEqual(['X']);
    expect(live(`describe.runIf(true)('d', () => { ${t} });`)).toEqual(['X']);
    expect(testCases(`describe.skip.each([1])('d', () => { ${t} });`)[0]?.skipped).toBe('包在 describe.skip.each 里');
    expect(testCases(`describe.skip('d', () => { ${t} });`)[0]?.skipped).toBe('包在 describe.skip 里');
  });

  it('Deno.test：ignore 不是字面 false 的不算；…展开的对象要在本文件里、不带 ignore；认不出的展开不算', () => {
    const body = "fn() { assertEquals(a, 'account_disabled'); }";
    expect(live(`Deno.test({ name: 'X', ignore: true, ${body} });`)).toEqual([]);
    expect(live(`Deno.test({ name: 'X', ignore: !db, ${body} });`)).toEqual([]);
    expect(live(`Deno.test({ name: 'X', ignore: false, ${body} });`)).toEqual(['X']);
    expect(live(`const opts = { sanitizeOps: false };\nDeno.test({ name: 'X', ...opts, async ${body} });`)).toEqual(['X']);
    expect(live(`const opts = { ignore: !db };\nDeno.test({ name: 'X', ...opts, async ${body} });`)).toEqual([]);
    expect(live(`import { opts } from './h.ts';\nDeno.test({ name: 'X', ...opts, async ${body} });`)).toEqual([]);
    expect(live(`Deno.test({ name: 'X', ...mk(), ${body} });`)).toEqual([]);
    expect(live(`Deno.test('X', { ignore: true }, () => { assertEquals(a, 'account_disabled'); });`)).toEqual([]);
    expect(live(`it('X', { skip: true }, () => {});`)).toEqual([]);
    expect(live(`Deno.test({ name: 'X', ['ignore']: true, ${body} });`)).toEqual([]);
    expect(live(`Deno.test({ name: 'X', [k]: true, ${body} });`)).toEqual([]);
  });

  it('展开的 opts：只认本文件里只定义一次的 const 对象字面量、别处没改它的属性', () => {
    const t = "Deno.test({ name: 'X', ...opts, fn() { assertEquals(a, 'account_disabled'); } });";
    expect(live(`const opts = { sanitizeOps: false };\n${t}`)).toEqual(['X']);
    expect(live(`let opts = { sanitizeOps: false };\nopts = { ignore: true };\n${t}`)).toEqual([]);
    expect(live(`const opts = { sanitizeOps: false };\nfunction g() { const opts = { ignore: true }; ${t} }`)).toEqual([]);
    expect(live(`const opts: any = { sanitizeOps: false };\nopts.ignore = true;\n${t}`)).toEqual([]);
    expect(live(`const opts: any = { sanitizeOps: false };\nopts['ignore'] = true;\n${t}`)).toEqual([]);
    expect(live(`const opts = { sanitizeOps: false };\nObject.assign(opts, { ignore: true });\n${t}`)).toEqual([]);
    expect(live(`const opts = { sanitizeOps: false };\nfunction g(opts) { ${t} }`)).toEqual([]);
  });

  it('真仓库：store-it 的 TC-B1-10 用例会跑（...opts 里没有 ignore）且断言了 account_disabled', async () => {
    const { readFileSync } = await import('node:fs');
    const code = readFileSync(new URL('../../supabase/tests/store-it/account-store.it.ts', import.meta.url), 'utf8');
    const tc = testCases(code).find((t) => t.title.startsWith('TC-B1-10：'));
    expect(tc?.skipped).toBeNull();
    expect(tc && assertsLiteral(tc, AD)).toBe(true);
  });
});

describe('用例：运行时才跳过（B1 接手清单 FN-cov-gaps ②）', () => {
  const E = "expect(r).toEqual({ error: 'account_disabled' });";
  const why = (code: string) => testCases(code)[0]?.skipped ?? null;

  it('算跳过：回调里直接执行的 return 后面还有断言（有分号、不写分号、块里 return、两条断言中间 return）', () => {
    for (const body of [
      `if (!db) return; ${E}`,
      `if (!db) return\n  ${E.replace(';', '')}`,
      `if (!db) { console.warn('没有库，跳过'); return; }\n${E}`,
      `if (!db) {\n  return\n}\n${E}`,
      `return;\n${E}`,
      `expect(1).toBe(1);\nif (!x) return;\n${E}`,
      `for (const k of ks) { if (!k) return; }\n${E}`,
    ]) {
      expect(why(`it('X', async () => {\n${body}\n});`), body).toBe('运行时可能跳过：回调里断言前有 return');
      expect(live(`it('X', async () => {\n${body}\n});`), body).toEqual([]);
    }
    expect(why("Deno.test({ name: 'X', async fn() { if (!db) return; assertEquals(a, 'account_disabled'); } });")).toBe('运行时可能跳过：回调里断言前有 return');
    expect(why("Deno.test('X', async () => { if (!db) return; assertEquals(a, 'account_disabled'); });")).toBe('运行时可能跳过：回调里断言前有 return');
    expect(why(`it('X', async function () { if (!db) return; ${E} });`)).toBe('运行时可能跳过：回调里断言前有 return');
  });

  it('算跳过：回调里调了 skip(…)（ctx.skip、context.skip(条件)、解构的 skip、this.skip），断言前后都算', () => {
    expect(why(`it('X', async (ctx) => { if (!db) ctx.skip(); ${E} });`)).toBe('运行时跳过：回调里调了 ctx.skip(…)');
    expect(why(`it('X', async (context) => { context.skip(!db, '没有库'); ${E} });`)).toBe('运行时跳过：回调里调了 context.skip(…)');
    expect(why(`it('X', ({ skip }) => { skip(); ${E} });`)).toBe('运行时跳过：回调里调了 skip(…)');
    expect(why(`it('X', function () { this.skip(); ${E} });`)).toBe('运行时跳过：回调里调了 this.skip(…)');
    expect(why(`it('X', async (ctx) => { ${E} ctx.skip(); });`)).toBe('运行时跳过：回调里调了 ctx.skip(…)');
    expect(why(`it('X', async (ctx) => { const s = () => ctx . skip (); s(); ${E} });`)).toBe('运行时跳过：回调里调了 ctx.skip(…)');
    expect(live(`it('X', async (ctx) => { ctx.skip(); });`)).toEqual([]);
  });

  it('不算（反例）：嵌套函数里的 return、断言之后的 return、return 自带断言、死分支里的 return / skip、名字或字符串里带 skip', () => {
    for (const body of [
      `const f = () => { return 1; };\n${E}`,
      `function g(x) { if (!x) return; return 2; }\n${E}`,
      `ks.forEach((k) => { if (!k) return; });\n${E}`,
      `const o = { m() { return 1; } };\n${E}`,
      `${E}\nreturn;`,
      `${E}\nif (!db) return`,
      "return expect(p).resolves.toEqual({ error: 'account_disabled' });",
      "return expect(p)\n  .resolves.toEqual({ error: 'account_disabled' });",
      `if (false) return;\n${E}`,
      `if (false) { ctx.skip(); }\n${E}`,
      `if (0) ctx.skip();\n${E}`,
      `const skipped = doSkip(r) + skipIf(1) + mySkip(2);\n${E}`,
      `const s = 'ctx.skip()';\n// ctx.skip();\n/* return; */\n${E}`,
      `x.return(1);\n${E}`,
    ]) {
      expect(why(`it('X', async (ctx) => {\n${body}\n});`), body).toBeNull();
      expect(assertsLiteral(one(`it('X', async (ctx) => {\n${body}\n});`), AD), body).toBe(true);
    }
  });

  it('不算（DBTEST-sugg ①）：紧挨着的上一句 expect 已经钉死条件的 if (…) return（类型收窄）', () => {
    for (const body of [
      `expect(r.ok).toBe(true);\nif (!r.ok) return;\n${E}`,
      `expect(r.ok).toBe(true);\nif (!r.ok) { return; }\n${E}`,
      `expect( r.ok ,'说明').toBe(true)\n;if ((!r.ok)) return\n${E}`,
      `expect(r.ok).toBe(false);\nif (r.ok) return;\n${E}`,
      `expect(m).toBeTruthy();\nif (!m) return;\n${E}`,
      `expect(m).toBeFalsy();\nif (m) return;\n${E}`,
      `expect(p).toBeDefined();\nif (p === undefined) return;\n${E}`,
      `for (const k of ks) { expect(k.ok).toBe(true); if (!k.ok) return; }\n${E}`,
      // 纯成员访问链：可选链、字面量下标；注释隔开照样算紧挨着（注释已遮成空格）
      `expect(r?.ok).toBe(true);\nif (!r?.ok) return;\n${E}`,
      `expect(r['ok']).toBe(true);\nif (!r['ok']) return;\n${E}`,
      `expect(r['a b']).toBe(true);\nif (! r[ 'a b' ]) return;\n${E}`,
      `expect(rs[0].ok).toBe(true);\nif (!rs[0].ok) return;\n${E}`,
      `expect(r.ok).toBe(true); // x\n/* y */ if (!r.ok) return;\n${E}`,
    ]) {
      expect(why(`it('X', async () => {\n${body}\n});`), body).toBeNull();
    }
  });

  it('照旧算跳过：守卫和条件对不上、不紧挨、条件执行、soft、.not、toBeDefined 配 !m、E 不是纯成员访问链', () => {
    for (const body of [
      `expect(r.ok).toBe(true);\nif (!r.okk) return;\n${E}`,
      `expect(r.ok).toBe(true);\nif (r.ok) return;\n${E}`,
      `expect(r.ok).toBe(1);\nif (!r.ok) return;\n${E}`,
      `expect(r.ok).toBe(true);\nconst x = 1;\nif (!r.ok) return;\n${E}`,
      `if (c) expect(r.ok).toBe(true);\nif (!r.ok) return;\n${E}`,
      `expect.soft(r.ok).toBe(true);\nif (!r.ok) return;\n${E}`,
      `expect(r.ok).not.toBe(false);\nif (!r.ok) return;\n${E}`,
      `expect(m).toBeDefined();\nif (!m) return;\n${E}`,
      `expect(r.ok).toBe(true);\nif (!r.ok) { log(); return; }\n${E}`,
      `expect(r.ok).toBe(true);\nif (!r.ok || x) return;\n${E}`,
      `const f = () => expect(r.ok).toBe(true);\nif (!r.ok) return;\n${E}`,
      // 审查必改：E 不是纯成员访问链的一律不认——运算符优先级（只比文本会把 !a || b 当成 !(a || b)）
      `expect(a || b).toBe(true);\nif (!a || b) return;\n${E}`,
      `expect(a && b).toBeTruthy();\nif (!a && b) return;\n${E}`,
      `expect(a + b).toBeTruthy();\nif (!a + b) return;\n${E}`,
      `expect(a || b).toBeDefined();\nif (a || b === undefined) return;\n${E}`,
      `expect(a ? b : c).toBeDefined();\nif (a ? b : c === undefined) return;\n${E}`,
      `expect(a ? b : c).toBe(false);\nif (a ? b : c) return;\n${E}`,
      // ……和带调用、await、自增、变量下标的（两次求值结果可以不同）
      `expect(it.next().done).toBe(false);\nif (it.next().done) return;\n${E}`,
      `expect(await ready()).toBe(true);\nif (!(await ready())) return;\n${E}`,
      `expect(i++).toBeFalsy();\nif (i++) return;\n${E}`,
      `expect(r[i++]).toBe(true);\nif (!r[i++]) return;\n${E}`,
      // toEqual / toStrictEqual 不当守卫：只认 Object.is 语义，偏严
      // 引号里的空白不能去掉：r['a b'] 和 r['ab'] 是两个键
      `expect(r['a b']).toBe(true);\nif (!r['ab']) return;\n${E}`,
      `expect(b).toEqual(false);\nif (b) return;\n${E}`,
      `expect(b).toStrictEqual(false);\nif (b) return;\n${E}`,
      `expect(r.ok).toEqual(true);\nif (!r.ok) return;\n${E}`,
      // 审查员试过不会误放的：.resolves、else / for / while / do 单句体、&& 和逗号里、label、try 块里、中间重新赋值、条件里赋值、可选链不一致、else 分支的 return
      `expect(p).resolves.toBe(true);\nif (!p) return;\n${E}`,
      `if (c) {} else expect(r.ok).toBe(true);\nif (!r.ok) return;\n${E}`,
      `for (const x of xs) expect(r.ok).toBe(true);\nif (!r.ok) return;\n${E}`,
      `while (0) expect(r.ok).toBe(true);\nif (!r.ok) return;\n${E}`,
      `do expect(r.ok).toBe(true); while (0);\nif (!r.ok) return;\n${E}`,
      `c && expect(r.ok).toBe(true);\nif (!r.ok) return;\n${E}`,
      `f(), expect(r.ok).toBe(true);\nif (!r.ok) return;\n${E}`,
      `L: expect(r.ok).toBe(true);\nif (!r.ok) return;\n${E}`,
      `try { expect(r.ok).toBe(true); } catch {}\nif (!r.ok) return;\n${E}`,
      `expect(r.ok).toBe(true); r = bad;\nif (!r.ok) return;\n${E}`,
      `expect(ok).toBe(true);\nif (!(ok = g())) return;\n${E}`,
      `expect(r.ok).toBe(true);\nif (!r?.ok) return;\n${E}`,
      `expect(r.ok).toBe(true);\nif (r.ok) {} else return;\n${E}`,
    ]) {
      expect(why(`it('X', async () => {\n${body}\n});`), body).toBe('运行时可能跳过：回调里断言前有 return');
    }
  });

  it('skip 只看名字（DBTEST-sugg ② 的边界）：别的对象的 .skip(n) 也算跳过；名字里只是带 skip 的不算', () => {
    expect(why(`it('X', async () => { const rows = await q.skip(5).take(1); ${E} });`)).toBe('运行时跳过：回调里调了 q.skip(…)');
    expect(why(`it('X', async () => { const page = q.skip.bind(q); ${E} });`)).toBeNull();
  });

  it('死分支：if (false) / if (0) / if ((null)) 的 then 分支里的断言不算；else 分支、非字面条件、名字以 false 开头的照算', () => {
    for (const body of [`if (false) { ${E} }`, `if (0) ${E}`, `if ((null)) {\n${E}\n}`, `if (undefined) ${E}`, `if ('') { ${E} }`, `if (!true) ${E}`, `if (void 0) ${E}`]) {
      expect(assertsLiteral(inIt(body), AD), body).toBe(false);
    }
    for (const body of [`if (false) {} else { ${E} }`, `if (x) { ${E} }`, `if (falsey) { ${E} }`, `if (false || x) { ${E} }`, `if (false) {}\n${E}`]) {
      expect(assertsLiteral(inIt(body), AD), body).toBe(true);
    }
  });
});

describe('断言：白名单、只看期望值、只认回调里直接执行的', () => {
  it('算：toEqual / toStrictEqual / toMatchObject / toBe、resolves、expect.soft；assertEquals 等四个的第 2 个参数', () => {
    expect(assertsLiteral(inIt("expect(await r.json()).toEqual({ error: 'account_disabled' });"), AD)).toBe(true);
    expect(assertsLiteral(inIt("expect(await res.json()).toMatchObject({ code: 'forbidden', reason: \"account_disabled\" });"), AD)).toBe(true);
    expect(assertsLiteral(inIt("expect(body.error).toBe('account_disabled');"), AD)).toBe(true);
    expect(assertsLiteral(inIt("await expect(p).resolves.toStrictEqual({ error: 'account_disabled' });"), AD)).toBe(true);
    expect(assertsLiteral(inIt("expect.soft(r).toEqual({ error: 'account_disabled' });"), AD)).toBe(true);
    expect(assertsLiteral(inIt("for (const a of ['x']) { expect(r, a).toEqual({ error: 'account_disabled' }); }"), AD)).toBe(true);
    expect(assertsLiteral(one("Deno.test('X', () => { assertEquals([rn.status, rn.json], [403, { error: 'account_disabled' }]); });"), AD)).toBe(true);
    expect(assertsLiteral(one("Deno.test('X', () => { assertStrictEquals(e, 'account_disabled'); });"), AD)).toBe(true);
    expect(assertsLiteral(one("Deno.test('X', () => { assertObjectMatch(j, { error: 'account_disabled' }); });"), AD)).toBe(true);
    expect(assertsLiteral(one("Deno.test('X', () => { assertMatch(m, /^account_disabled$/); });"), AD)).toBe(true);
    expect(assertsLiteral(one("Deno.test('X', () => { assertMatch(m, /^P0001 account_disabled$/i); });"), AD)).toBe(true);
  });

  it('不算：期望值里有 .not.（expect.not.objectContaining 等）；assertMatch 没整串锚定、带 |、不是正则字面量', () => {
    expect(assertsLiteral(inIt("expect(r).toEqual(expect.not.objectContaining({ error: 'account_disabled' }));"), AD)).toBe(false);
    expect(assertsLiteral(inIt("expect(r).toMatchObject({ error: expect.not.stringMatching('account_disabled') });"), AD)).toBe(false);
    expect(assertsLiteral(inIt("expect(r).toMatchObject({ a: expect . not . stringContaining('x'), error: 'account_disabled' });"), AD)).toBe(false);
    expect(assertsLiteral(one("Deno.test('X', () => { assertMatch(m, /account_disabled/); });"), AD)).toBe(false);
    expect(assertsLiteral(one("Deno.test('X', () => { assertMatch(m, /^account_disabled|ok$/); });"), AD)).toBe(false);
    expect(assertsLiteral(one("Deno.test('X', () => { assertMatch(m, /^(account_disabled|ok)$/); });"), AD)).toBe(false);
    expect(assertsLiteral(one("Deno.test('X', () => { assertMatch(m, new RegExp('^account_disabled$')); });"), AD)).toBe(false);
  });

  it('不算：assertNotEquals、assertFalse、assert.equal、.not、rejects.toThrow、码在 expect 参数或提示文字里、未调用的 helper、只赋值', () => {
    expect(assertsLiteral(one("Deno.test('X', () => { assertNotEquals(r.error, 'account_disabled'); });"), AD)).toBe(false);
    expect(assertsLiteral(one("Deno.test('X', () => { assertFalse(r.error === 'account_disabled'); });"), AD)).toBe(false);
    expect(assertsLiteral(one("Deno.test('X', () => { assertEquals(r.status, 200, 'account_disabled'); });"), AD)).toBe(false);
    expect(assertsLiteral(inIt("assert.equal(r.error, 'account_disabled');"), AD)).toBe(false);
    expect(assertsLiteral(inIt("expect(r).not.toEqual({ error: 'account_disabled' });"), AD)).toBe(false);
    expect(assertsLiteral(inIt("await expect(p).rejects.toThrow('account_disabled');"), AD)).toBe(false);
    expect(assertsLiteral(inIt("expect(r.error === 'account_disabled').toBe(false);"), AD)).toBe(false);
    expect(assertsLiteral(inIt("expect(r.status, 'account_disabled').toBe(200);"), AD)).toBe(false);
    expect(assertsLiteral(inIt("const chk = () => expect(r).toEqual({ error: 'account_disabled' });\nexpect(1).toBe(1);"), AD)).toBe(false);
    expect(assertsLiteral(inIt("function chk() { expect(r).toEqual({ error: 'account_disabled' }); }\nexpect(1).toBe(1);"), AD)).toBe(false);
    expect(assertsLiteral(inIt("s.batchError = 'account_disabled';\nexpect(1).toBe(1);"), AD)).toBe(false);
    expect(assertsLiteral(inIt("expect(r).toEqual({ error: 'account_disabled_x' });"), AD)).toBe(false);
  });

  it('hasAssertion：只认白名单断言', () => {
    expect(hasAssertion(inIt('expect(sent).toEqual([]);'))).toBe(true);
    expect(hasAssertion(inIt('console.log(sent);'))).toBe(false);
    expect(hasAssertion(inIt('assertFalse(sent.length > 0);'))).toBe(false);
  });
});

describe('config.toml', () => {
  it('段落（含空格、引号）、点号键（段内、根上）、内联表（段内、根上）都认；false、注释、字符串里的 # 不算', () => {
    const toml = [
      '[functions.a]', 'verify_jwt = true',
      '[ functions."b-c" ]', 'verify_jwt = false',
      '[functions]', '"d".verify_jwt = true', 'e = { verify_jwt = true, entrypoint = "./x#y.ts" }', 'f.entrypoint = "./f.ts"',
      '# [functions.g]', '# verify_jwt = true',
    ].join('\n');
    expect([...verifyJwtTrue(toml)].sort()).toEqual(['a', 'd', 'e']);
    expect([...tomlFunctions(toml).keys()].sort()).toEqual(['a', 'b-c', 'd', 'e', 'f']);
    expect(tomlFunctions(toml).get('e')?.get('entrypoint')).toBe('"./x#y.ts"');
    expect([...verifyJwtTrue('functions.x.verify_jwt = true\n')]).toEqual(['x']);
    expect([...verifyJwtTrue('functions = { r2-probe = { verify_jwt = false }, ai-embed = { verify_jwt = true } }\n[api]\nenabled = true\n')]).toEqual(['ai-embed']);
  });
});
