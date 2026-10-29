// 测试用的轻量 TS 扫描器（tests/build/fn-account-disabled-coverage.test.ts 用，TC-B1-10、TC-B1-109）：
// 去注释、把字符串、模板的字面部分、正则字面量换成空格（长度不变，下标对得上；模板 ${…} 里照代码扫），再找用例、断言、引用。
// 不 import typescript：否则引它的测试文件按 tests/arch/coverage.test.ts 要登记进 vitest.config.ts 的 SLOW_NODE_TESTS。
// 正反例在 tests/build/ts-scan.test.ts。偏严：认不出的写法宁可当“没覆盖”，不当“覆盖了”。

export type Scanned = { text: string; skel: string };

/** 这些词后面的 / 是正则开头（其余词、) ] } 和后置 ++ -- 后面是除号） */
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'case', 'of', 'in', 'else', 'await', 'yield', 'void', 'throw', 'new', 'delete', 'do']);

/** text：注释换成空格；skel：再把字符串、模板字面部分、正则字面量的内容换成空格（引号留着），用来找括号、调用 */
export function scan(code: string): Scanned {
  const text = code.split(''), skel = code.split('');
  const n = code.length;
  const blank = (arr: string[], from: number, to: number) => { for (let k = from; k < Math.min(to, n); k++) if (arr[k] !== '\n') arr[k] = ' '; };
  let prev = '', prevWord = '';
  const regexOk = () => prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || REGEX_AFTER_WORD.has(prevWord);

  function template(start: number): number {
    let j = start + 1, lit = j;
    while (j < n && code[j] !== '`') {
      if (code[j] === '\\') { j += 2; continue; }
      if (code[j] === '$' && code[j + 1] === '{') {
        blank(skel, lit, j);
        prev = '{'; prevWord = '';
        j = run(j + 2, true);
        lit = j;
        continue;
      }
      j++;
    }
    blank(skel, lit, j);
    return j + 1;
  }

  /** 扫代码；inExpr（模板的 ${…}）时遇到本层的 } 返回它后面的下标 */
  function run(start: number, inExpr: boolean): number {
    let i = start, depth = 0;
    while (i < n) {
      const c = code[i] ?? '';
      const d = code[i + 1] ?? '';
      if (c === '/' && (d === '/' || d === '*')) {
        const cl = d === '/' ? code.indexOf('\n', i) : code.indexOf('*/', i + 2);
        const end = cl < 0 ? n : d === '/' ? cl : cl + 2;
        blank(text, i, end); blank(skel, i, end); i = end; continue;
      }
      if (c === '\'' || c === '"') {
        let j = i + 1;
        while (j < n && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
        blank(skel, i + 1, j); i = j + 1; prev = c; prevWord = ''; continue;
      }
      if (c === '`') { i = template(i); prev = '`'; prevWord = ''; continue; }
      if (c === '/' && regexOk()) {
        let j = i + 1, cls = false;
        while (j < n && code[j] !== '\n' && (cls || code[j] !== '/')) {
          if (code[j] === '\\') { j += 2; continue; }
          if (code[j] === '[') cls = true; else if (code[j] === ']') cls = false;
          j++;
        }
        blank(skel, i + 1, j); i = j + 1; prev = ')'; prevWord = ''; continue;
      }
      if (/[\w$]/.test(c)) {
        let j = i;
        while (j < n && /[\w$]/.test(code[j] ?? '')) j++;
        prevWord = code.slice(i, j); prev = 'a'; i = j; continue;
      }
      if ((c === '+' || c === '-') && d === c) { prev = ')'; prevWord = ''; i += 2; continue; }
      if (inExpr && c === '{') depth++;
      if (inExpr && c === '}') { if (depth === 0) return i + 1; depth--; }
      if (!/\s/.test(c)) { prev = c; prevWord = ''; }
      i++;
    }
    return n;
  }

  run(0, false);
  return { text: text.join(''), skel: skel.join('') };
}

/** skel 里 open 处的 ( [ { 对应的闭括号下标；找不到回 -1 */
export function matchClose(skel: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let k = open; k < skel.length; k++) {
    const ch = skel[k] ?? '';
    if (ch in pairs) stack.push(pairs[ch] ?? '');
    else if (ch === ')' || ch === ']' || ch === '}') { if (stack.pop() !== ch) return -1; if (stack.length === 0) return k; }
  }
  return -1;
}

/** 括号 open..close 之间按顶层逗号切开：[起, 止) 列表 */
function splitTop(skel: string, open: number, close: number): [number, number][] {
  const out: [number, number][] = [];
  let depth = 0, from = open + 1;
  for (let k = open + 1; k < close; k++) {
    const ch = skel[k];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) { out.push([from, k]); from = k + 1; }
  }
  if (skel.slice(from, close).trim() !== '') out.push([from, close]);
  return out;
}

const firstNonSpace = (s: string, at: number) => { let k = at; while (/\s/.test(s[k] ?? '')) k++; return k; };

/** 字符串字面量的内容（skel 里引号之间是空格，闭引号就是下一个同样的引号） */
function literalAt(sc: Scanned, at: number): string | null {
  const q = sc.skel[at] ?? '', close = sc.skel.indexOf(q, at + 1);
  return (q !== '\'' && q !== '"' && q !== '`') || close < 0 ? null : sc.text.slice(at + 1, close);
}

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
    out.push({ title, body: sc.text.slice(open, close + 1), skel: sc.skel.slice(open, close + 1), skipped });
  }
  return out;
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

/** 用例回调里直接执行（不在嵌套函数里）的白名单断言：返回“期望值”参数的文本（expect 链取匹配器的参数，assert 取第 2 个参数） */
function expectations(tc: Pick<TestCase, 'body' | 'skel'>): { fn: string; text: string }[] {
  const { skel, body } = tc, fns = fnSpans(skel);
  const direct = (pos: number) => fns.filter((s) => s[0] <= pos && pos <= s[1]).length === 1;
  const out: { fn: string; text: string }[] = [];
  for (const m of skel.matchAll(/(?<![\w$.])expect(?:\s*\.\s*soft)?\s*\(/g)) {
    const start = m.index ?? 0;
    let end = matchClose(skel, start + m[0].length - 1), lastCall: [number, number] | null = null;
    const names: string[] = [];
    while (end > 0) {
      const rest = skel.slice(end + 1), dot = /^\s*\.\s*([\w$]+)/.exec(rest);
      if (dot) { names.push(dot[1] ?? ''); end += dot[0].length; lastCall = null; continue; }
      const call = names.length > 0 ? /^\s*\(/.exec(rest) : null; if (!call) break;
      const o = end + call[0].length;
      end = matchClose(skel, o); lastCall = [o, end];
    }
    const matcher = names[names.length - 1] ?? '', mods = names.slice(0, -1);
    if (!lastCall || lastCall[1] < 0 || !MATCHERS.has(matcher) || mods.some((x) => x !== 'resolves') || !direct(start)) continue;
    out.push({ fn: matcher, text: body.slice(lastCall[0] + 1, lastCall[1]) });
  }
  for (const m of skel.matchAll(/(?<![\w$.])([\w$]+)\s*\(/g)) {
    const fn = m[1] ?? '', o = (m.index ?? 0) + m[0].length - 1; if (!ASSERT_FNS.has(fn) || !direct(m.index ?? 0)) continue;
    const arg = splitTop(skel, o, matchClose(skel, o))[1];
    if (arg) out.push({ fn, text: body.slice(arg[0], arg[1]) });
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

// ---------------- config.toml：只认这里用得到的子集（段落、点号键、内联表） ----------------

function splitKey(k: string): string[] {
  const out: string[] = [], re = /\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))\s*(?:\.|$)/y;
  let m: RegExpExecArray | null;
  while (re.lastIndex < k.length && (m = re.exec(k))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/** 在引号、括号外找第一个 ch（at 处开始） */
function topIndex(s: string, ch: string): number {
  let q = '', depth = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k] ?? ''; if (q) { if (c === q) q = ''; continue; }
    if (c === '"' || c === '\'') q = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ch && depth === 0) return k;
  }
  return -1;
}

/** config.toml 里声明的函数：名字 → { 键: 原样的值 }（[functions.x]、[functions] 下 x.k = v、x = { k = v }、根上 functions = { x = { … } }） */
export function tomlFunctions(toml: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const ensure = (path: string[]) => {
    const nm = path[0] === 'functions' ? path[1] : undefined;
    if (nm !== undefined && !out.has(nm)) out.set(nm, new Map());
    return nm === undefined ? undefined : out.get(nm);
  };
  const put = (path: string[], raw: string) => {
    const v = raw.trim(), kv0 = ensure(path);
    if (v.startsWith('{') && v.endsWith('}')) {
      let body = v.slice(1, -1);
      while (body.trim() !== '') {
        const comma = topIndex(body, ','), kv = comma < 0 ? body : body.slice(0, comma), eq = topIndex(kv, '=');
        if (eq > 0) put([...path, ...splitKey(kv.slice(0, eq))], kv.slice(eq + 1));
        body = comma < 0 ? '' : body.slice(comma + 1);
      }
      return;
    }
    if (path.length >= 3) kv0?.set(path.slice(2).join('.'), v);
  };
  let section: string[] = [];
  for (const raw of toml.split('\n')) {
    const hash = topIndex(raw, '#'), line = (hash < 0 ? raw : raw.slice(0, hash)).trim();
    if (!line) continue;
    if (line.startsWith('[[')) { section = ['[[]]']; continue; }
    const sec = /^\[\s*(.+?)\s*\]$/.exec(line);
    if (sec) { section = splitKey(sec[1] ?? ''); ensure(section); continue; }
    const eq = topIndex(line, '=');
    if (eq > 0) put([...section, ...splitKey(line.slice(0, eq))], line.slice(eq + 1));
  }
  return out;
}

/** config.toml 里 verify_jwt = true 的函数 */
export function verifyJwtTrue(toml: string): Set<string> {
  return new Set([...tomlFunctions(toml)].filter(([, kv]) => kv.get('verify_jwt') === 'true').map(([nm]) => nm));
}
