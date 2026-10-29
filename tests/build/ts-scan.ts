// 测试用的轻量 TS 扫描器（tests/build/fn-account-disabled-coverage.test.ts 用，TC-B1-10、TC-B1-109）：
// 去注释、把字符串、模板的字面部分、正则字面量换成空格（长度不变，下标对得上；模板 ${…} 里照代码扫），再找用例、断言、引用。
// 不 import typescript：否则引它的测试文件按 tests/arch/coverage.test.ts 要登记进 vitest.config.ts 的 SLOW_NODE_TESTS。
// 正反例在 tests/build/ts-scan.test.ts。偏严：认不出的写法宁可当“没覆盖”，不当“覆盖了”。

import { firstNonSpace, literalAt, matchClose, scan, splitTop, stmtEnd, type Scanned } from './ts-scan-core.ts';

export { matchClose, scan, type Scanned } from './ts-scan-core.ts';

const SKIP_KEYS = new Set(['ignore', 'skip', 'todo', 'fails']);

/** 选项对象（open..close 是 { }）会让用例不跑就回原因：ignore / skip / todo / fails 不是字面 false；…展开的对象要在本文件里、同样检查 */
function optionsSkip(sc: Scanned, open: number, close: number, depth = 0): string | null {
  for (const [a, b] of splitTop(sc.skel, open, close)) {
    const seg = sc.text.slice(a, b).trim();
    if (seg.startsWith('...')) {
      const sp = /^\.\.\.\s*([\w$]+)$/.exec(seg); if (!sp || depth > 3) return `展开 ${seg} 认不出`;
      // 只认本文件里只定义一次的 const 对象字面量（同名的 let、var、函数、参数、解构都算另一次定义），而且别处没改它的属性
      const nm = sp[1] ?? '';
      const decls = [...sc.skel.matchAll(new RegExp(`(?<![\\w$.])(?:const|let|var|function|class)\\s+${nm}(?![\\w$])|[{,(]\\s*${nm}\\s*[,)}=:]`, 'g'))];
      const def = new RegExp(`(?<![\\w$.])const\\s+${nm}\\s*(?::[^=]*)?=\\s*\\{`).exec(sc.skel);
      if (!def || decls.length !== 1) return `展开的 ${nm} 要是本文件里只定义一次的 const 对象字面量`;
      if (new RegExp(`(?<![\\w$.])${nm}\\s*(?:\\.\\s*[\\w$]+|\\[[^\\]]*\\])\\s*=(?!=)|assign\\s*\\(\\s*${nm}(?![\\w$])`).test(sc.skel)) return `展开的 ${nm} 在别处被改了属性`;
      const o = def.index + def[0].length - 1, c = matchClose(sc.skel, o);
      const r = c < 0 ? `展开的 ${sp[1]} 认不出` : optionsSkip(sc, o, c, depth + 1);
      if (r) return r; continue;
    }
    const k = /^(?:async\s+)?(?:([\w$]+)|'([^']*)'|"([^"]*)"|\[\s*(?:'([^']*)'|"([^"]*)"|`([^`$]*)`)\s*\])\s*(:)?/.exec(seg);
    const key = k?.[1] ?? k?.[2] ?? k?.[3] ?? k?.[4] ?? k?.[5] ?? k?.[6];
    if (seg.startsWith('[') && key === undefined) return `计算键 ${seg} 认不出`;
    if (key !== undefined && SKIP_KEYS.has(key) && !(k?.[7] === ':' && seg.slice(seg.indexOf(':') + 1).trim() === 'false')) return seg;
  }
  return null;
}

/** 第 2 个及以后的参数里任一个对象字面量让它不跑：回原因 */
function argsSkip(sc: Scanned, args: [number, number][]): string | null {
  for (const [a0] of args.slice(1)) {
    const o = firstNonSpace(sc.skel, a0);
    const why = sc.skel[o] === '{' ? optionsSkip(sc, o, matchClose(sc.skel, o)) : null;
    if (why !== null) return why;
  }
  return null;
}

/**
 * describe / suite（vitest 里 describe 的别名）、xdescribe 整条调用链里会让整组不跑的范围：链上出现 skip、todo、skipIf 一律算跳过，
 * runIf 的条件不是字面 true 也算（describe.concurrent.skip、describe.skip.each([…])(…)、describe.runIf(c)(…) 都按链判断）；
 * 最后那次调用（真正的 describe(名, …)）的参数里有 { skip / todo / ignore / fails … } 选项对象也算。
 */
function skippedSpans(sc: Scanned): { span: [number, number]; why: string }[] {
  const out: { span: [number, number]; why: string }[] = [];
  for (const m of sc.skel.matchAll(/(?<![\w$.])(xdescribe|describe|suite)(?=\s*[.(])/g)) {
    let k = (m.index ?? 0) + m[0].length;
    const names: string[] = [], callOf = new Map<string, [number, number]>();
    let last: [number, number] | null = null;
    for (;;) {
      const rest = sc.skel.slice(k), dot = /^\s*\.\s*([\w$]+)/.exec(rest);
      if (dot) { names.push(dot[1] ?? ''); k += dot[0].length; continue; }
      const par = /^\s*\(/.exec(rest); if (!par) break;
      const o = k + par[0].length - 1, c = matchClose(sc.skel, o);
      if (c < 0) break; last = [o, c];
      const nm = names[names.length - 1];
      if (nm !== undefined && !callOf.has(nm)) callOf.set(nm, last);
      k = c + 1;
    }
    if (!last) continue;
    const chain = [m[1], ...names].join('.');
    const run = callOf.get('runIf');
    let why: string | null = m[1] === 'xdescribe' || names.some((x) => x === 'skip' || x === 'todo' || x === 'skipIf') ? chain : null;
    if (why === null && names.includes('runIf') && (!run || sc.text.slice(run[0] + 1, run[1]).trim() !== 'true')) why = chain;
    why ??= argsSkip(sc, splitTop(sc.skel, last[0], last[1]));
    if (why !== null) out.push({ span: last, why });
  }
  return out;
}

/** skipped：这条用例不会跑的原因（null = 会跑） */
export type TestCase = { title: string; body: string; skel: string; skipped: string | null };

/** 文件里的 it(…)、test(…)、Deno.test(…)：用例名、整段调用、会不会跑（it.skip、it.only、.each 之类不收） */
export function testCases(code: string): TestCase[] {
  const sc = scan(code);
  const spans = skippedSpans(sc);
  const out: TestCase[] = [];
  for (const m of sc.skel.matchAll(/(?<![\w$.])(?:it|test|Deno\s*\.\s*test)\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1, close = matchClose(sc.skel, open);
    const args = close < 0 ? [] : splitTop(sc.skel, open, close);
    if (!args[0]) continue;
    const at = firstNonSpace(sc.skel, args[0][0]);
    let title = literalAt(sc, at), skipped: string | null = null;
    if (title === null && sc.skel[at] === '{') {
      const oc = matchClose(sc.skel, at);
      const nameSeg = splitTop(sc.skel, at, oc).find(([a]) => /^\s*name\s*:/.test(sc.skel.slice(a)));
      if (nameSeg) title = literalAt(sc, firstNonSpace(sc.skel, sc.skel.indexOf(':', nameSeg[0]) + 1));
      skipped = optionsSkip(sc, at, oc);
    } else skipped = argsSkip(sc, args);
    if (title === null) continue;
    const inSkip = spans.find((s) => s.span[0] < open && close < s.span[1]);
    if (inSkip) skipped = `包在 ${inSkip.why} 里`;
    const body = sc.text.slice(open, close + 1), skel = sc.skel.slice(open, close + 1);
    skipped ??= runtimeSkip({ body, skel });
    out.push({ title, body, skel, skipped });
  }
  return out;
}

const FALSY = /^(?:false|0|null|undefined|NaN|void\s+0|!\s*(?:true|1)|''|""|``)$/;

/** 永远不执行的 then 分支：if (false) / if (0) / if (null) … 后面那一句或那一块（else 分支照常执行，不算） */
function deadSpans(tc: Pick<TestCase, 'body' | 'skel'>): [number, number][] {
  const { skel, body } = tc, out: [number, number][] = [];
  for (const m of skel.matchAll(/(?<![\w$.])if\s*\(/g)) {
    const o = (m.index ?? 0) + m[0].length - 1, c = matchClose(skel, o); if (c < 0) continue;
    let cond = body.slice(o + 1, c).trim();
    while (/^\(.*\)$/s.test(cond) && matchClose(cond, 0) === cond.length - 1) cond = cond.slice(1, -1).trim();
    if (!FALSY.test(cond)) continue;
    const at = firstNonSpace(skel, c + 1);
    out.push([at, skel[at] === '{' ? matchClose(skel, at) : stmtEnd(skel, at)]);
  }
  return out;
}

/** 只有一层函数（用例回调本身）包着 pos：回调里直接执行，不在嵌套函数里 */
const directIn = (skel: string) => { const fns = fnSpans(skel); return (pos: number) => fns.filter((s) => s[0] <= pos && pos <= s[1]).length === 1; };

/**
 * 运行时才跳过（FN-cov-gaps ②；静态的 it.skip、describe.skip、{ skip / ignore } 选项在上面）：回原因，null = 会跑。
 * ① 回调里直接执行的 return（if (!db) return、if (!db) { …; return; } 都算）后面还有白名单断言：断言可能不执行；
 *   return 那一句自己带的断言（return expect(p).resolves.toBe(x)）不算在“后面”；嵌套函数里的 return 不算；
 *   紧挨着的上一句 expect 已经钉死了条件的 if (…) return（类型收窄写法，见 guardedReturn）不算。
 * ② 回调里任何地方调了 skip(…)（vitest 的 ctx.skip()、context.skip(cond)、解构出来的 skip()、mocha 的 this.skip()）：
 *   不论前后有没有断言都算（偏严）。边界（DBTEST-sugg ②）：只看调用名是不是 skip，不看是谁的 skip——
 *   查询构造器、游标、数组包装之类别的对象的 .skip(n)、自己定义的同名函数 skip(…) 也一律算“运行时跳过”（误报只会让用例被当成不会跑，
 *   不会当成覆盖了）；被 PLAN 引用的用例里真要用这种 API，就换个名字包一层（如 const page = q.skip.bind(q)，不写成 skip( 调用）。
 *   skipIf(…)、mySkip(…)、x.skipped 这类名字里只是带 skip 的不算。
 * if (false) {…} 这类永远不执行的分支里的 return、skip 不算（里面的断言也不算，见 expectations）。
 * 认不出的：经变量间接调 skip（const s = ctx.skip; s()）、throw 后的断言、process.exit 之类，照旧当会跑。
 */
function runtimeSkip(tc: Pick<TestCase, 'body' | 'skel'>): string | null {
  const { skel } = tc, direct = directIn(skel), dead = deadSpans(tc);
  const live = (p: number) => !dead.some(([a, b]) => a <= p && p <= b);
  for (const m of skel.matchAll(/(?<![\w$])skip\s*\(/g)) {
    const at = m.index ?? 0; if (!live(at)) continue;
    const recv = (/(?:[\w$]+\s*\.\s*)?$/.exec(skel.slice(Math.max(0, at - 40), at))?.[0] ?? '').replace(/\s+/g, '');
    return `运行时跳过：回调里调了 ${recv}skip(…)`;
  }
  const asserts = expectations(tc).map((e) => e.at), chains = expectChains(tc);
  for (const m of skel.matchAll(/(?<![\w$.])return(?![\w$])/g)) {
    const r = m.index ?? 0; if (!direct(r) || !live(r)) continue;
    const end = stmtEnd(skel, r + 'return'.length);
    if (asserts.some((q) => q > end) && !guardedReturn(tc, r, chains)) return '运行时可能跳过：回调里断言前有 return';
  }
  return null;
}

const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with']);

/** 一段代码里各个函数体的范围：箭头函数（块体、表达式体）、function、方法简写 */
function fnSpans(skel: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of skel.matchAll(/=>/g)) {
    const at = firstNonSpace(skel, (m.index ?? 0) + 2);
    if (skel[at] === '{') { const c = matchClose(skel, at); if (c > 0) out.push([at, c]); continue; }
    let depth = 0, k = at;
    for (let ch = skel[k] ?? ''; k < skel.length; ch = skel[++k] ?? '') {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) { if (depth === 0) break; depth--; } else if ((ch === ',' || ch === ';') && depth === 0) break;
    }
    out.push([at, k]);
  }
  for (const m of skel.matchAll(/(?<![\w$.])(?:function\s*\*?\s*[\w$]*|([\w$]+))\s*\(/g)) {
    if (m[1] !== undefined && CONTROL.has(m[1])) continue;
    const pc = matchClose(skel, (m.index ?? 0) + m[0].length - 1);
    const after = pc < 0 ? null : /^\s*(?::[^{;=]*)?\{/.exec(skel.slice(pc + 1));
    const o = after ? pc + after[0].length : -1, c = o < 0 ? -1 : matchClose(skel, o);
    if (c > 0) out.push([o, c]);
  }
  return out;
}

const ASSERT_FNS = new Set(['assertEquals', 'assertStrictEquals', 'assertObjectMatch', 'assertMatch']);
const MATCHERS = new Set(['toEqual', 'toStrictEqual', 'toMatchObject', 'toBe']);

/** 一条 expect 链：expect(subject…)[.mods].matcher(arg)；soft = expect.soft（失败不抛，不能当守卫）；end = 链最后的 ) */
type ExpectChain = { start: number; soft: boolean; subject: string; matcher: string; mods: string[]; arg: string; end: number };

/** 用例回调里直接执行（不在嵌套函数里、不在 if (false) 死分支里）的 expect 链 */
function expectChains(tc: Pick<TestCase, 'body' | 'skel'>): ExpectChain[] {
  const { skel, body } = tc, inFn = directIn(skel), dead = deadSpans(tc);
  const direct = (pos: number) => inFn(pos) && !dead.some(([a, b]) => a <= pos && pos <= b);
  const out: ExpectChain[] = [];
  for (const m of skel.matchAll(/(?<![\w$.])expect(\s*\.\s*soft)?\s*\(/g)) {
    const start = m.index ?? 0, open = start + m[0].length - 1;
    let end = matchClose(skel, open), lastCall: [number, number] | null = null;
    const subj = end < 0 ? undefined : splitTop(skel, open, end)[0];
    const names: string[] = [];
    while (end > 0) {
      const rest = skel.slice(end + 1), dot = /^\s*\.\s*([\w$]+)/.exec(rest);
      if (dot) { names.push(dot[1] ?? ''); end += dot[0].length; lastCall = null; continue; }
      const call = names.length > 0 ? /^\s*\(/.exec(rest) : null; if (!call) break;
      const o = end + call[0].length;
      end = matchClose(skel, o); lastCall = [o, end];
    }
    if (!lastCall || lastCall[1] < 0 || !subj || !direct(start)) continue;
    out.push({
      start, soft: m[1] !== undefined, subject: body.slice(subj[0], subj[1]), matcher: names[names.length - 1] ?? '',
      mods: names.slice(0, -1), arg: body.slice(lastCall[0] + 1, lastCall[1]), end: lastCall[1],
    });
  }
  return out;
}

/** 去掉引号外的空白（引号里的原样留着） */
const squash = (s: string) => s.replace(/('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|\s+/g, (_m, q: string | undefined) => q ?? '');

/** 守卫的 E 只许纯标识符或成员访问链：a、r.ok、r?.ok、r['k']、r[0]（下标只许数字或字符串字面量）；运算、调用、await、++、模板都不认 */
const PURE_PATH = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\[(?:\d+|'[^'\\]*'|"[^"\\]*")\])*$/;

/** if 条件去掉外层括号 */
const unparen = (s: string) => { let c = s.trim(); while (/^\(.*\)$/s.test(c) && matchClose(c, 0) === c.length - 1) c = c.slice(1, -1).trim(); return c; };

/**
 * 守卫：return 是 if (cond) return 的整个 then 分支，而且 if 紧挨着的上一句（同一块、只隔空白和 ;）是一条会抛的 expect，
 * 它通过就意味着 cond 为假（DBTEST-sugg ①：expect(r.ok).toBe(true); if (!r.ok) return; 是类型收窄，不会跳过断言）。认的组合：
 *   if (!E) ← expect(E).toBe(true) / toBeTruthy()
 *   if (E)  ← expect(E).toBe(false) / toBeFalsy()（toEqual / toStrictEqual 不认：只认 Object.is 语义，偏严）
 *   if (E === undefined) ← expect(E).toBeDefined()
 * E 只许纯标识符或成员访问链（PURE_PATH；a || b、a + b、三元、it.next().done、await ready()、i++ 一律不认，免得优先级或重复求值骗过），
 *   两边去空白后逐字相同；那条 expect 前面得是 ; { }（语句开头，不是 if (c) expect(…) 这种条件执行的）；expect.soft、带 .not / .resolves 的不认。
 * 不认（照旧算可能跳过，偏严）：expect(m).toBeDefined(); if (!m) return;（m 是 null 时 toBeDefined 也过，return 真会执行）——
 * 要写成 expect(m).toBeTruthy() 或 if (m === undefined) return；中间隔了别的语句、不写分号、else 分支里的 return 也不认。
 */
function guardedReturn(tc: Pick<TestCase, 'body' | 'skel'>, r: number, chains: ExpectChain[]): boolean {
  const { skel, body } = tc, retEnd = stmtEnd(skel, r + 'return'.length);
  if (skel.slice(r + 'return'.length, retEnd).trim() !== '') return false;
  for (const m of skel.matchAll(/(?<![\w$.])if\s*\(/g)) {
    const ifAt = m.index ?? 0, o = ifAt + m[0].length - 1, c = matchClose(skel, o); if (c < 0 || c > r) continue;
    const at = firstNonSpace(skel, c + 1);
    let whole = at === r;
    if (!whole && skel[at] === '{') {
      const bc = matchClose(skel, at), afterRet = firstNonSpace(skel, skel[retEnd] === ';' ? retEnd + 1 : retEnd);
      whole = firstNonSpace(skel, at + 1) === r && afterRet === bc;
    }
    if (!whole) continue;
    let before = ifAt - 1;
    while (before >= 0 && /[\s;]/.test(skel[before] ?? '')) before--;
    const g = chains.find((e) => e.end === before);
    if (!g || g.soft || g.mods.length > 0) return false;
    let p = g.start - 1; while (p >= 0 && /\s/.test(skel[p] ?? '')) p--;
    if (p >= 0 && !';{}'.includes(skel[p] ?? '')) return false;
    // 先拿原文过 PURE_PATH（审查必改：只比文本不管优先级，a || b 对 !a || b；带调用、await、++ 的还会重复求值），
    //   再只去掉引号外的空白比对（r['a b'] 和 r['ab'] 是两个键）
    const raw = g.subject.trim(); if (!PURE_PATH.test(raw)) return false;
    const cond = squash(unparen(body.slice(o + 1, c))), subj = squash(raw), arg = squash(g.arg);
    const eq = g.matcher === 'toBe';   // 只认 Object.is 语义（偏严）
    if (cond === `!${subj}` || cond === `!(${subj})`) return (eq && arg === 'true') || (g.matcher === 'toBeTruthy' && arg === '');
    if (cond === subj) return (eq && arg === 'false') || (g.matcher === 'toBeFalsy' && arg === '');
    if (cond === `${subj}===undefined`) return g.matcher === 'toBeDefined' && arg === '';
    return false;
  }
  return false;
}

/**
 * 用例回调里直接执行（不在嵌套函数里）的白名单断言：返回“期望值”参数的文本（expect 链取匹配器的参数，assert 取第 2 个参数）和断言的起点；
 * if (false) {…} 这类永远不执行的分支里的不算
 */
function expectations(tc: Pick<TestCase, 'body' | 'skel'>): { fn: string; text: string; at: number }[] {
  const { skel, body } = tc, inFn = directIn(skel), dead = deadSpans(tc);
  const direct = (pos: number) => inFn(pos) && !dead.some(([a, b]) => a <= pos && pos <= b);
  const out: { fn: string; text: string; at: number }[] = [];
  for (const e of expectChains(tc)) {
    if (!MATCHERS.has(e.matcher) || e.mods.some((x) => x !== 'resolves')) continue;
    out.push({ fn: e.matcher, text: e.arg, at: e.start });
  }
  for (const m of skel.matchAll(/(?<![\w$.])([\w$]+)\s*\(/g)) {
    const fn = m[1] ?? '', o = (m.index ?? 0) + m[0].length - 1; if (!ASSERT_FNS.has(fn) || !direct(m.index ?? 0)) continue;
    const arg = splitTop(skel, o, matchClose(skel, o))[1];
    if (arg) out.push({ fn, text: body.slice(arg[0], arg[1]), at: m.index ?? 0 });
  }
  return out;
}

/**
 * 期望值里有 want：字符串字面量完全等于它；assertMatch 要是整串锚定（/^…$/）、不含 | 的正则字面量，里面有 want。
 * 期望值里出现 .not.（expect.not.objectContaining、expect.not.stringMatching 之类）的那一条不算。
 */
export function assertsLiteral(tc: Pick<TestCase, 'body' | 'skel'>, want: string): boolean {
  const esc = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lit = new RegExp(`(['"\`])${esc}\\1`);
  return expectations(tc).some((e) => {
    if (/\.\s*not\s*\./.test(e.text)) return false;
    if (e.fn !== 'assertMatch') return lit.test(e.text);
    const re = /^\/\^([^|]*)\$\/[dgimsuy]*$/.exec(e.text.trim());
    return re !== null && new RegExp(`(?<![\\w])${esc}(?![\\w])`).test(re[1] ?? '');
  });
}

/** 至少有一条直接执行的白名单断言 */
export function hasAssertion(tc: Pick<TestCase, 'body' | 'skel'>): boolean {
  return expectations(tc).length > 0;
}

/**
 * 源码里（import 语句之外）引用了 name：直接写名字、经 import 别名、经命名空间（x.name）、在模板 ${…} 里都算；注释、字符串里不算。
 * 已知的宽松点：放宽成“引用”以后，`export const _ = requireActiveUser` 这种只引用、不调用的写法也会算进去
 * （jwt 那边因此偏松；no-user、all-users 那边反而更严）。
 * import / export … from 的匹配不跨过 ; ( =，不写分号的代码里不会从 export function 一路吞到后面的 from。
 */
export function references(code: string, name: string): boolean {
  const { skel } = scan(code);
  const importRe = /(?<![\w$.])(?:import|export)\s+(?:type\s+)?([^;(=]*?)\s*from\s*(['"`])\s*\2/g;
  const names = new Set([name]);
  for (const m of skel.matchAll(importRe)) {
    for (const spec of (/\{([^}]*)\}/.exec(m[1] ?? '')?.[1] ?? '').split(',')) {
      const a = /^\s*(?:type\s+)?([\w$]+)\s+as\s+([\w$]+)\s*$/.exec(spec);
      if (a?.[1] === name && a[2]) names.add(a[2]);
    }
  }
  const rest = skel.replace(importRe, (s) => ' '.repeat(s.length));
  return [...names].some((nm) => new RegExp(`(?<![\\w$])${nm.replace(/\$/g, '\\$')}(?![\\w$])`).test(rest));
}

// config.toml 的解析（tomlFunctions、verifyJwtTrue）在 ts-scan-toml.ts，这里转出，调用方照旧从 ts-scan.ts 引
export { tomlFunctions, verifyJwtTrue } from './ts-scan-toml.ts';
