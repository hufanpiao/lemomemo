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
