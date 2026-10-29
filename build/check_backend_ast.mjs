// build/check_backend.py 的解析器一侧（代码审查第三轮必改 1：不再用手写词法器，改用 TypeScript 编译器 API 解析成 AST）
// 用法：node build/check_backend_ast.mjs < 输入.json > 输出.json（只由 check_backend.py 调用）
//   输入：{ "files": [{ "rel": "<相对 supabase/functions 或仓库根的路径>", "path": "<绝对路径>", "f7": true|false, "fnRel": "<相对 supabase/functions 的路径或 null>" }] }
//   输出：{ "<rel>": { "code": 去掉注释的源码（和原文等长、换行不变）, "imports": [...], "findings": [{ "line", "message" }], "parseError": 文字或 null } }
// code 只把 AST 的注释区间换成空格（注释位置由解析器给出，正则、模板字符串、JSX 文本都不会被误当成注释），F1～F6 的名字匹配在它上面做。
// findings 是 F7 的结论，全部在 AST 上判断（f7 为 true 的文件才查，也就是 supabase/functions 下的源码）：
//   ① Deno 只准 Deno.env.get('字面量') / Deno.env.has('字面量') / Deno.serve(…)（_shared/db.ts 另准 Deno.env.get(URL_ENV[role])）；
//   ② process 只准默认导入的那个名字、process.env.名字、process.env['字面量']、process.别的属性；
//      ①② 的字面量里不准有反斜杠转义（'\x52\x32_FN_…' 这类，B1 接手清单 S3：值和源码原文不同，名字匹配看不见）；
//   ③ globalThis、self、window 只准跟 .标识符（不准当参数、不准存进变量、不准方括号、不准 ?.）；Reflect.get、
//      Object.getOwnPropertyDescriptor 的第一个参数是它们的单独说明；唯一例外见 GLOBAL_ALIASES；
//   ④ 禁用 eval、Function、require、createRequire、constructor、__proto__、getPrototypeOf、Worker、SharedWorker（不论怎么调用、是不是属性名，
//      值正好是这些名字的字符串也报）；node:module、data: / blob: 地址由 check_backend.py 按 import 查；
//   ⑤ 标识符里写反斜杠 u 转义的报；字符串字面量的值正好是 Deno、process、globalThis 的报；
//   ⑥ 动态 import( ) 的第一个参数必须是字符串字面量（或不带 ${} 的反引号）。
//   ⑦ 方括号取值、解构计算键、Reflect / Object 按键取属性的键：用类型检查器判，规则见 KEY_TYPE_WHITELIST 上方（第五、六轮）；
//      Reflect 只准直接调用，Object.getOwnPropertyDescriptors 禁用；检查器建不起来或取类型出错时报错、不放行。
//   ⑧ 普通函数、对象字面量方法里不准用 this；Object.values / keys / entries / assign… 的参数、对象展开 { ...x } 的类型
//      不准是 any、unknown、object、{}、EventTarget 这类（第七、八轮）；全局的 addEventListener / dispatchEvent / removeEventListener 禁用（第八轮）；
//      全局事件属性 onunhandledrejection、onerror、onload… 不带前缀或挂在全局对象上的，赋值、读取都禁用（第八轮低）。
//   定位：拦住常见写法，其余靠代码审查（check_backend.py 文件头剩余风险①）。
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** globalThis 的别名白名单：[supabase/functions 下的文件, 变量名]。只准 const 名 = globalThis as …，之后这个名字也只准跟 .标识符。
 *  10-29 核对现有源码只有这一处：objstore-net.ts 的计时器（由 build/copy_shared.mjs 从 shared/ 复制） */
const GLOBAL_ALIASES = [['_shared/gen/objstore-net.ts', 'G']];
const GLOBALS = new Set(['globalThis', 'self', 'window']);
const BANNED = new Set(['eval', 'Function', 'require', 'createRequire']);
/** 第四轮必改 1、3：能拿到 Function 构造器（(() => 0).constructor('…')）、原型链的名字，和能跑任意代码的 Worker——标识符形式（含属性名）一律禁用 */
const BANNED_PROTO = new Set(['constructor', '__proto__', 'getPrototypeOf', 'Worker', 'SharedWorker']);
/** 值正好是这些的字符串也报（拿来当方括号里的属性名就能绕开上面的检查）；拼出来的（'constr' + 'uctor'）AST 堵不住，见 check_backend.py 文件头“剩余风险” */
//   eval、Function、require 不进这张表：'require' 是 postgres 的 ssl 选项（_shared/db.ts），它们作为属性名只在 globalThis 上有用，globalThis 的方括号已禁
const BAD_STRINGS = new Set(['Deno', 'process', 'globalThis', ...BANNED_PROTO]);

/** 原文里第一处不准的转义（见 checkF7 开头），没有返回 null */
const OK_ESC = new Set(['n', 'r', 't', 'b', 'f', 'v', '0', '\\', "'", '"', '`', '$']);
const badEscape = (raw) => {
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '\\') continue;
    const c = raw[i + 1] ?? '';
    if (!OK_ESC.has(c) || (c === '0' && /[0-9]/.test(raw[i + 2] ?? ''))) return raw.slice(i, i + 2);
    i += 1;
  }
  return null;
};
const kindOf = (p) => (/\.tsx$/.test(p) ? ts.ScriptKind.TSX : /\.jsx$/.test(p) ? ts.ScriptKind.JSX : /\.(c|m)?js$/.test(p) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
const isLit = (n) => !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
const isName = (n, name) => !!n && ts.isIdentifier(n) && n.text === name;
/** 跳过括号和类型断言（(x)、x as T、<T>x、x!、x satisfies T） */
const unwrapUp = (n) => {
  let p = n.parent;
  while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isTypeAssertionExpression(p) || ts.isNonNullExpression(p) || ts.isSatisfiesExpression(p))) { n = p; p = n.parent; }
  return n;
};
/** a.b（不带 ?.）里 node 是 a 时返回这个属性访问 */
const dotAfter = (node) => {
  const p = node.parent;
  return p && ts.isPropertyAccessExpression(p) && p.expression === node && !p.questionDotToken ? p : undefined;
};

/** 第五～七轮：方括号取值 x[k]、解构计算键 { [k]: v }、Reflect / Object 取属性函数的键参数，统一走 checkKey → keyProblem。
 *  定位（第七轮主持人定）：F7 拦住常见写法，其余靠代码审查（见 check_backend.py 文件头剩余风险①）。规则：
 *    · 键是字符串 / 数字字面量：放行（值正好是 constructor、Deno 这类的另由 BAD_STRINGS 报）；
 *    · Object.hasOwn 守卫（第七轮）：Object.hasOwn(o, k) ? o[k] : …、Object.hasOwn(o, k) && o[k]，o 和 k 都是同一个名字、
 *      o 的类型不是 any / unknown：放行——只取自有属性，拿不到原型链上的 constructor；
 *    · 用类型检查器取键的类型，每一支只准 number、数字 / 字符串 / 布尔字面量、unique symbol；string、any、unknown、类型参数、枚举一律报；
 *    · 类型里有字符串字面量的：必须顺着定义追到字面量（literalValue：const 名 = '字面量'、两支都是字面量的条件表达式、for (const 名 of [字面量…])）；
 *    · 类型是 number 的（第七轮收紧）：只放行数字字面量（含 const 名 = 数字字面量）、for (let i = …; …) 的下标变量、x.length，
 *      以及由它们组成的算术（+ - * / % 位运算、取负）；调用返回值、参数、JSON.parse 之类一律报；
 *    · 检查器取类型时抛异常：报（宁可报错不放行）。
 *  KEY_TYPE_WHITELIST（第七轮必改 3，第八轮改稳）：每条绑到节点——at 是取值的位置“文件:函数链#本函数里同样文本的第几处”
 *  （嵌套函数里的不算进外层），obj、key 是对象 / 键最左边那个名字的声明：顶层声明“文件:名字”，参数“文件:函数链(参数名)”，
 *  函数里的局部变量“文件:函数链>名字”。改前面的代码不影响；同样的签名和取值复制进别的函数，函数名不同就对不上。
 *  命中后还要求对象类型不是 any / unknown、取出来的值类型不是 any / unknown、不是函数。 */
const KEY_TYPE_WHITELIST = [
  // @@WHITELIST@@（10-29 第八轮按新定位在真仓库上核对生成，共 19 条）
  // ① 字面量联合类型的参数键（第七轮协调方定：保留）
  { file: "_shared/db.ts", expr: "URL_ENV[role]",
    at: "_shared/db.ts:connect#1", obj: "_shared/db.ts:URL_ENV", key: "_shared/db.ts:connect(role)" },
  { file: "_shared/db.ts", expr: "URL_ENV[role]",
    at: "_shared/db.ts:connect#2", obj: "_shared/db.ts:URL_ENV", key: "_shared/db.ts:connect(role)" },
  { file: "_shared/gen/i18n/pick-locale.ts", expr: "TO_UI[locale]",
    at: "_shared/gen/i18n/pick-locale.ts:toUiLocale#1", obj: "_shared/gen/i18n/pick-locale.ts:TO_UI", key: "_shared/gen/i18n/pick-locale.ts:toUiLocale(locale)" },
  { file: "_shared/gen/schema/rows.ts", expr: "WRITE_RULES[table]",
    at: "_shared/gen/schema/rows.ts:insertSchema#1", obj: "_shared/gen/schema/rows.ts:WRITE_RULES", key: "_shared/gen/schema/rows.ts:insertSchema(table)" },
  { file: "_shared/gen/schema/rows.ts", expr: "WRITE_RULES[table]",
    at: "_shared/gen/schema/rows.ts:patchSchema#1", obj: "_shared/gen/schema/rows.ts:WRITE_RULES", key: "_shared/gen/schema/rows.ts:patchSchema(table)" },
  { file: "_shared/gen/schema/rows.ts", expr: "rowsWrite[table]",
    at: "_shared/gen/schema/rows.ts:shapeWithout#1", obj: "_shared/gen/schema/rows.ts:rowsWrite", key: "_shared/gen/schema/rows.ts:shapeWithout(table)" },
  { file: "invite-signup/core.ts", expr: "TURNSTILE_HOSTS[deps.env]",
    at: "invite-signup/core.ts:start#1", obj: "invite-signup/core.ts:TURNSTILE_HOSTS", key: "invite-signup/core.ts:start(deps)" },
  // ② 第七轮 number 键收紧后新增：本地数字变量的位运算 / 下标算术（待协调方定改写还是保留）
  { file: "_shared/gen/i18n/fmt.ts", expr: "WD_KEYS[((i%7)+7)%7]",
    at: "_shared/gen/i18n/fmt.ts:weekdayName#1", obj: "_shared/gen/i18n/fmt.ts:WD_KEYS", key: "_shared/gen/i18n/fmt.ts:weekdayName(i)" },
  { file: "_shared/gen/objstore-wire.ts", expr: "B64[(n>>12)&63]",
    at: "_shared/gen/objstore-wire.ts:base64#1", obj: "_shared/gen/objstore-wire.ts:B64", key: "_shared/gen/objstore-wire.ts:base64>n" },
  { file: "_shared/gen/objstore-wire.ts", expr: "B64[(n>>18)&63]",
    at: "_shared/gen/objstore-wire.ts:base64#1", obj: "_shared/gen/objstore-wire.ts:B64", key: "_shared/gen/objstore-wire.ts:base64>n" },
  { file: "_shared/gen/objstore-wire.ts", expr: "B64[(n>>6)&63]",
    at: "_shared/gen/objstore-wire.ts:base64#1", obj: "_shared/gen/objstore-wire.ts:B64", key: "_shared/gen/objstore-wire.ts:base64>n" },
  { file: "_shared/gen/objstore-wire.ts", expr: "B64[n&63]",
    at: "_shared/gen/objstore-wire.ts:base64#1", obj: "_shared/gen/objstore-wire.ts:B64", key: "_shared/gen/objstore-wire.ts:base64>n" },
  { file: "_shared/gen/objstore-wire.ts", expr: "out[j*4+k]",
    at: "_shared/gen/objstore-wire.ts:md5><匿名>#1", obj: "_shared/gen/objstore-wire.ts:md5>out", key: "_shared/gen/objstore-wire.ts:md5><匿名>(j)" },
  { file: "_shared/gen/objstore-wire.ts", expr: "words[blk*16+g]",
    at: "_shared/gen/objstore-wire.ts:md5#1", obj: "_shared/gen/objstore-wire.ts:md5>words", key: "_shared/gen/objstore-wire.ts:md5>blk" },
  { file: "_shared/gen/objstore-wire.ts", expr: "words[len>>2]",
    at: "_shared/gen/objstore-wire.ts:md5#1", obj: "_shared/gen/objstore-wire.ts:md5>words", key: "_shared/gen/objstore-wire.ts:md5>len" },
  { file: "_shared/gen/objstore-wire.ts", expr: "words[len>>2]",
    at: "_shared/gen/objstore-wire.ts:md5#2", obj: "_shared/gen/objstore-wire.ts:md5>words", key: "_shared/gen/objstore-wire.ts:md5>len" },
  { file: "_shared/gen/objstore-wire.ts", expr: "words[nBlocks*16-1]",
    at: "_shared/gen/objstore-wire.ts:md5#1", obj: "_shared/gen/objstore-wire.ts:md5>words", key: "_shared/gen/objstore-wire.ts:md5>nBlocks" },
  { file: "_shared/gen/objstore-wire.ts", expr: "words[nBlocks*16-2]",
    at: "_shared/gen/objstore-wire.ts:md5#1", obj: "_shared/gen/objstore-wire.ts:md5>words", key: "_shared/gen/objstore-wire.ts:md5>nBlocks" },
  { file: "account/index.ts", expr: "ACCOUNT_ERROR_CODES[i]",
    at: "account/index.ts:<匿名>#1", obj: "_shared/gen/schema/account.ts:ACCOUNT_ERROR_CODES", key: "account/index.ts:<匿名>(i)" },
];

/** Reflect / Object 上按键取属性的函数：第二个参数（键）走同一条规则 */
const KEY_FNS = new Set(['Reflect.get', 'Reflect.has', 'Reflect.set', 'Reflect.getOwnPropertyDescriptor', 'Reflect.defineProperty', 'Reflect.deleteProperty',
  'Object.getOwnPropertyDescriptor', 'Object.defineProperty']);
/** 第一个参数是要调用的函数：只准是函数声明 / const 名 = 箭头函数或函数表达式 */
const APPLY_FNS = new Set(['Reflect.apply', 'Reflect.construct']);
/** 一次拿走全部属性描述的：没有键参数可查，直接禁用 */
const BANNED_FNS = new Set(['Object.getOwnPropertyDescriptors']);
/** 第七轮必改 1：整个对象拿来遍历 / 拷贝的，参数类型是 any / unknown 就报（看不出遍历的是什么对象） */
const ENUM_FNS = new Set(['Object.values', 'Object.entries', 'Object.keys', 'Object.assign', 'Object.getOwnPropertyNames', 'Object.fromEntries']);

const norm = (s) => s.replace(/\s+/g, '');
const EVENT_FNS = new Set(['addEventListener', 'dispatchEvent', 'removeEventListener']);
/** 第八轮低：全局事件属性（赋值、读取都不准；不带前缀的、挂在 globalThis / self / window 上的） */
const EVENT_PROPS = new Set(['onunhandledrejection', 'onrejectionhandled', 'onerror', 'onload', 'onbeforeunload', 'onunload', 'onmessage']);
const ASSERT = (n) => ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n);
const ARITH = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken]);

/** 外层函数链（从外到内的函数名）和最内层函数节点 */
function fnChain(node) {
  const sf = node.getSourceFile();
  const names = [];
  let inner = null;
  for (let c = node.parent; c && !ts.isSourceFile(c); c = c.parent) {
    if (!ts.isFunctionLike(c)) continue;
    inner ??= c;
    const p = c.parent;
    const nm = c.name && (ts.isIdentifier(c.name) || ts.isStringLiteral(c.name)) ? c.name.text
      : p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) ? p.name.text
      : p && ts.isPropertyAssignment(p) ? p.name.getText(sf) : '<匿名>';
    names.unshift(nm);
  }
  return { chain: names.join('>'), inner };
}
const fileOf = (node) => node.getSourceFile().fileName.split('/supabase/functions/').pop();
/** 声明的位置（第八轮改稳）：顶层声明“文件:名字”；参数“文件:函数链(参数名)”；函数里的局部变量“文件:函数链>名字” */
function locateDecl(d) {
  const sf = d.getSourceFile();
  const name = d.name && ts.isIdentifier(d.name) ? d.name.text : norm(d.getText(sf)).slice(0, 60);
  const { chain } = fnChain(d);
  if (ts.isParameter(d)) return `${fileOf(d)}:${chain}(${name})`;
  return chain ? `${fileOf(d)}:${chain}>${name}` : `${fileOf(d)}:${name}`;
}
/** 取值的位置（第八轮改稳）：“文件:函数链#本函数里同样文本、同种节点的第几处”（嵌套函数里的不算进外层） */
function locateAccess(node) {
  const sf = node.getSourceFile();
  const { chain, inner } = fnChain(node);
  const text = norm(node.getText(sf));
  let count = 0, idx = 0;
  const walk = (n) => {
    if (n.kind === node.kind && fnChain(n).inner === inner && norm(n.getText(sf)) === text) { count += 1; if (n === node) idx = count; }
    ts.forEachChild(n, walk);
  };
  walk(inner ?? sf);
  return `${fileOf(node)}:${chain || '<顶层>'}#${idx}`;
}

function makeKeyRules(checker) {
  // 测试开关（tests/build 用，只会让检查更严）：模拟检查器取键类型时抛异常，证明这种情况报错、不放行
  const typeOf = process.env.CHECK_BACKEND_FAIL_TYPE ? () => { throw new Error('测试用：CHECK_BACKEND_FAIL_TYPE'); } : (n) => checker.getTypeAtLocation(n);
  const resolve = (id) => {
    let s = checker.getSymbolAtLocation(id);
    if (s && s.flags & ts.SymbolFlags.Alias) { try { s = checker.getAliasedSymbol(s); } catch { /* 解析不动就用原来的 */ } }
    return s;
  };
  const anyish = (t) => !t || (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
  const isConstDecl = (d) => ts.isVariableDeclaration(d) && ts.isVariableDeclarationList(d.parent) && (d.parent.flags & ts.NodeFlags.Const) !== 0;
  const forOfOf = (d) => ts.isVariableDeclarationList(d.parent) && ts.isForOfStatement(d.parent.parent) && d.parent.parent.initializer === d.parent ? d.parent.parent : undefined;
  const forIndex = (d) => ts.isVariableDeclaration(d) && ts.isVariableDeclarationList(d.parent) && ts.isForStatement(d.parent.parent) && d.parent.parent.initializer === d.parent;

  /** 值本身是不是字面量（追定义） */
  const literalValue = (e, seen = new Set()) => {
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e)) return true;
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) return true;
    if (ts.isParenthesizedExpression(e) || ASSERT(e)) return literalValue(e.expression, seen);
    if (ts.isConditionalExpression(e)) return literalValue(e.whenTrue, seen) && literalValue(e.whenFalse, seen);
    if (!ts.isIdentifier(e)) return false;
    const s = resolve(e);
    if (!s || seen.has(s) || !s.declarations?.length) return false;
    seen.add(s);
    return s.declarations.every((d) => {
      if (!ts.isVariableDeclaration(d) || !ts.isIdentifier(d.name)) return false;
      const fo = forOfOf(d);
      if (fo) return isConstDecl(d) && literalArray(fo.expression, seen);
      return isConstDecl(d) && !!d.initializer && literalValue(d.initializer, seen);
    });
  };
  const literalArray = (e, seen) => {
    if (ts.isParenthesizedExpression(e) || ASSERT(e)) return literalArray(e.expression, seen);
    if (ts.isArrayLiteralExpression(e)) return e.elements.every((x) => literalValue(x, seen));
    if (!ts.isIdentifier(e)) return false;
    const s = resolve(e);
    if (!s || seen.has(s) || !s.declarations?.length) return false;
    seen.add(s);
    return s.declarations.every((d) => isConstDecl(d) && ts.isIdentifier(d.name) && !!d.initializer && literalArray(d.initializer, seen));
  };

  /** 第七轮必改 2：number 键只放行数字字面量、const 数字常量、for 循环下标变量、x.length，以及它们组成的算术 */
  const numericSafe = (e) => {
    if (ts.isNumericLiteral(e)) return true;
    if (ts.isParenthesizedExpression(e)) return numericSafe(e.expression);
    if (ts.isPrefixUnaryExpression(e) && (e.operator === ts.SyntaxKind.MinusToken || e.operator === ts.SyntaxKind.PlusToken)) return numericSafe(e.operand);
    if (ts.isBinaryExpression(e) && ARITH.has(e.operatorToken.kind)) return numericSafe(e.left) && numericSafe(e.right);
    if (ts.isPropertyAccessExpression(e) && e.name.text === 'length' && !e.questionDotToken) {
      try { return !anyish(typeOf(e.expression)); } catch { return false; }
    }
    if (ts.isIdentifier(e)) {
      try { if (anyish(typeOf(e))) return false; } catch { return false; }
      if (literalValue(e)) return true;
      const ds = resolve(e)?.declarations ?? [];
      return ds.length > 0 && ds.every(forIndex);
    }
    return false;
  };

  /** Object.hasOwn(o, k) ? o[k] : …  /  Object.hasOwn(o, k) && o[k]：o、k 都是名字且和守卫里的是同一个 */
  const hasOwnGuarded = (access) => {
    if (!ts.isElementAccessExpression(access) || access.questionDotToken) return false;
    const o = access.expression, k = access.argumentExpression;
    if (!ts.isIdentifier(o) || !ts.isIdentifier(k)) return false;
    try { if (anyish(typeOf(o))) return false; } catch { return false; }
    let up = access;
    while (up.parent && ts.isParenthesizedExpression(up.parent)) up = up.parent;
    const p = up.parent;
    const cond = p && ts.isConditionalExpression(p) && p.whenTrue === up ? p.condition
      : p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && p.right === up ? p.left : null;
    if (!cond || !ts.isCallExpression(cond) || cond.arguments.length !== 2) return false;
    const c = cond.expression;
    if (!ts.isPropertyAccessExpression(c) || !ts.isIdentifier(c.expression) || c.expression.text !== 'Object' || c.name.text !== 'hasOwn') return false;
    const [a0, a1] = cond.arguments;
    return ts.isIdentifier(a0) && ts.isIdentifier(a1) && resolve(a0) === resolve(o) && resolve(a1) === resolve(k);
  };

  /** 最左边那个名字的声明节点的位置 */
  const rootDecl = (e) => {
    let n = e;
    for (;;) {
      if (ts.isParenthesizedExpression(n) || ASSERT(n)) n = n.expression;
      else if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n)) n = n.expression;
      else if (ts.isBinaryExpression(n)) n = n.left;
      else break;
    }
    if (!ts.isIdentifier(n)) return '';
    const d = resolve(n)?.declarations?.[0];
    return d ? locateDecl(d) : '';
  };
  const concrete = (t) => !anyish(t) && t.getCallSignatures().length === 0 && t.getConstructSignatures().length === 0;

  /** 白名单命中（五样都对上）且类型满足要求：返回 { ok, entry, why } */
  const whitelisted = (fnRel, where, obj, key, valueNode) => {
    const entry = { file: fnRel, expr: norm(where.getText(where.getSourceFile())), at: locateAccess(where), obj: obj ? rootDecl(obj) : '', key: rootDecl(key) };
    const hit = KEY_TYPE_WHITELIST.some((w) => w.file === entry.file && w.expr === entry.expr && w.at === entry.at && w.obj === entry.obj && w.key === entry.key);
    if (!hit) return { ok: false, entry };
    let ot, vt;
    try { ot = obj ? typeOf(obj) : null; vt = typeOf(valueNode); } catch { return { ok: false, entry, why: '在白名单里，但类型检查器取类型出错' }; }
    if (obj && anyish(ot)) return { ok: false, entry, why: '在白名单里，但被取值的对象类型是 any / unknown' };
    if (!concrete(vt)) return { ok: false, entry, why: '在白名单里，但取出来的值类型是 any / unknown 或函数（字典查表取出来的应当是具体的值）' };
    return { ok: true, entry };
  };

  /** 返回问题说明（要报）或 null（放行） */
  const keyProblem = (k) => {
    let t;
    try { t = typeOf(k); } catch (e) { return `类型检查器取键的类型时出错（${e instanceof Error ? e.message : e}），宁可报错不放行`; }
    const parts = t.isUnion() ? t.types : [t];
    if (parts.some((p) => p.flags & (ts.TypeFlags.EnumLiteral | ts.TypeFlags.Enum))) return '键的类型是枚举（enum 成员可以是拼出来的字符串），不准用';
    const okFlags = ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral | ts.TypeFlags.StringLiteral | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.UniqueESSymbol;
    if (parts.some((p) => !(p.flags & okFlags))) return '键的类型是 string（或推断不出来），不准用：string 变量可能是拼出来的 constructor、Deno 等（只准字面量；字典查表请用 Object.hasOwn(o, k) ? o[k] : … 或 Map）';
    if (parts.some((p) => p.flags & ts.TypeFlags.StringLiteral)) {
      if (!literalValue(k)) return '键的类型是字符串字面量，但顺着定义追不到字面量（参数、属性、函数返回值、as 断言出来的都算追不到）';
      return null;
    }
    if (!numericSafe(k)) return '键的类型是 number，但不是数字字面量、for 循环下标或 .length 的算术（调用返回值、参数、JSON.parse 之类都可能实际是字符串）';
    return null;
  };
  /** Reflect.apply / construct 的第一个参数：函数声明，或 const 名 = 箭头函数 / 函数表达式 */
  const staticFn = (f) => {
    if (!ts.isIdentifier(f)) return false;
    const ds = resolve(f)?.declarations ?? [];
    return ds.length > 0 && ds.every((d) => ts.isFunctionDeclaration(d)
      || (isConstDecl(d) && !!d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))));
  };
  /** 参数类型是不是 any / unknown（取不到也算是） */
  /** 第八轮必改 ②：遍历 / 拷贝 / 展开的对象类型看不出是什么——any、unknown、object、{}，或带 addEventListener / dispatchEvent 的（EventTarget、全局对象这类） */
  const vagueObj = (t) => {
    if (anyish(t)) return true;
    const parts = t.isUnion() || t.isIntersection() ? t.types : [t];
    return parts.some((p) => {
      if (anyish(p) || p.flags & ts.TypeFlags.NonPrimitive) return true;
      if (!(p.flags & ts.TypeFlags.Object)) return false;
      if (checker.getPropertyOfType(p, 'dispatchEvent') || checker.getPropertyOfType(p, 'addEventListener')) return true;
      return checker.getPropertiesOfType(p).length === 0 && checker.getIndexInfosOfType(p).length === 0
        && p.getCallSignatures().length === 0 && p.getConstructSignatures().length === 0;   // {}
    });
  };
  /** 对象字面量（或两支都是对象字面量的条件表达式）本身看得见内容，不看类型；其余按类型判 */
  const argAnyish = (a) => {
    let e = a;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isObjectLiteralExpression(e)) return false;
    if (ts.isConditionalExpression(e)) return argAnyish(e.whenTrue) || argAnyish(e.whenFalse);
    try { return vagueObj(typeOf(a)); } catch { return true; }
  };
  /** 不带前缀的名字是不是指向全局（声明都在 TypeScript 自带的 lib 文件里，或者解析不到声明） */
  const isGlobalName = (id) => {
    // 简写属性 { x } 的名字解析到的是新对象的属性，值的来源要用 getShorthandAssignmentValueSymbol 取
    const sym = id.parent && ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id ? checker.getShorthandAssignmentValueSymbol(id.parent) : resolve(id);
    const ds = sym?.declarations ?? [];
    return ds.length === 0 || ds.every((d) => d.getSourceFile().hasNoDefaultLib || /[\\/]typescript[\\/]lib[\\/]/.test(d.getSourceFile().fileName));
  };
  return { keyProblem, whitelisted, staticFn, hasOwnGuarded, argAnyish, isGlobalName };
}

function analyse(path, rel, f7, fnRel, rules, program) {
  const text = readFileSync(path, 'utf8');
  const sf = (program && program.getSourceFile(path)) || ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kindOf(path));
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  // ---- 去注释：每个记号前面的 trivia 里，解析器认出的注释区间换成空格 ----
  const out = text.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; };
  const strip = (node) => {
    const start = node.getStart(sf, false);
    for (const r of ts.getLeadingCommentRanges(text, node.pos) ?? []) if (r.end <= start) blank(r.pos, r.end);
    for (const c of node.getChildren(sf)) strip(c);
  };
  strip(sf);
  const code = out.join('');

  const diags = sf.parseDiagnostics ?? [];
  const parseError = diags.length ? ts.flattenDiagnosticMessageText(diags[0].messageText, ' ') + `（第 ${lineOf(diags[0].start ?? 0)} 行）` : null;

  const imports = [];
  const findings = [];
  const bad = (node, message) => findings.push({ line: lineOf(node.getStart(sf)), message });
  const aliases = new Set(GLOBAL_ALIASES.filter(([f]) => f === fnRel).map(([, n]) => n));
  /** 键检查（第五、六轮）：字面量放行；白名单（四样对上且类型具体）放行；否则看 keyProblem。
   *  环境变量 CHECK_BACKEND_KEY_DEBUG=1 时在说明后面附上白名单条目的写法，核对后再抄进 KEY_TYPE_WHITELIST */
  const checkKey = (where, k, obj, valueNode, label) => {
    if (isLit(k) || ts.isNumericLiteral(k)) return;
    if (rules.hasOwnGuarded(where)) return;   // 第七轮：Object.hasOwn(o, k) ? o[k] : … 只取自有属性
    const w = rules.whitelisted(fnRel, where, obj, k, valueNode);
    if (w.ok) return;
    if (w.why) { bad(where, `${label}${w.why}`); return; }
    const why = rules.keyProblem(k);
    if (why) bad(where, `${label}${why}` + (process.env.CHECK_BACKEND_KEY_DEBUG ? ` @@WL ${JSON.stringify(w.entry)}` : ''));
  };

  const visit = (node) => {
    // ---- import 边 ----
    if (ts.isImportDeclaration(node) && isLit(node.moduleSpecifier)) {
      const c = node.importClause;
      const nb = c?.namedBindings;
      imports.push({
        line: lineOf(node.getStart(sf)), spec: node.moduleSpecifier.text, kind: 'import', typeOnly: !!c?.isTypeOnly,
        defaultName: c?.name?.text ?? null, named: !!nb && ts.isNamedImports(nb), namespace: !!nb && ts.isNamespaceImport(nb), bare: !c,
        // B1 接手清单 S3 复审必改（F2 按导出名判断角色）：每个具名绑定的原名（改名导入看 propertyName）、是不是 type 导入
        names: nb && ts.isNamedImports(nb) ? nb.elements.map((e) => ({ name: (e.propertyName ?? e.name).text, typeOnly: !!c?.isTypeOnly || e.isTypeOnly })) : [],
      });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && isLit(node.moduleSpecifier)) {
      const ec = node.exportClause;
      imports.push({
        line: lineOf(node.getStart(sf)), spec: node.moduleSpecifier.text, kind: 'export', typeOnly: node.isTypeOnly,
        // export * from / export * as ns from：整个模块转手出去（同上，F2 看不出转出去的是哪个导出）
        star: !ec || ts.isNamespaceExport(ec),
        names: ec && ts.isNamedExports(ec) ? ec.elements.map((e) => ({ name: (e.propertyName ?? e.name).text, typeOnly: node.isTypeOnly || e.isTypeOnly })) : [],
      });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && isLit(node.moduleReference.expression)) {
      imports.push({ line: lineOf(node.getStart(sf)), spec: node.moduleReference.expression.text, kind: 'require', typeOnly: node.isTypeOnly });
      if (f7) bad(node, 'import x = require(…) 不准用（require 一律禁用）');
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = node.arguments[0];
      if (isLit(a)) imports.push({ line: lineOf(node.getStart(sf)), spec: a.text, kind: 'dynamic', typeOnly: false });
      else if (f7) bad(node, '动态 import( ) 的第一个参数必须是字符串字面量（拼接、变量、带 ${} 的模板字符串都看不出引的是什么，F2、F3、F6 查不了）');
    }

    if (f7) checkF7(node);
    ts.forEachChild(node, visit);
  };

  /** B1 接手清单 S3（拼接环境变量名）：字面量的源码原文（去掉两边引号）和它的值一字不差，也就是里面没有反斜杠转义。
   *  Deno.env.get('\x52\x32_FN_…')、'FN_VAULT\u005fDB_URL' 这类值和原文不同，F1～F3 在源码文本上做的名字匹配看不见 */
  const rawIsValue = (n) => text.slice(n.getStart(sf) + 1, n.end - 1) === n.text;

  const checkF7 = (node) => {
    // B1 接手清单 S3 返工（10-29 审查必改 1）：字符串字面量、模板片段里一律不准写会改变名字的转义——
    //   \x、\u、八进制（\1～\7、\0 后跟数字）、续行（\ 换行）、以及 \_ \a 这类“原样转义”。只准 \n \r \t \b \f \v \0 \\ \' \" \` \$，
    //   这些转出来的都不是名字里能有的字符。否则 withScan('fn\x5fvault')、URL_ENV 的值写成 '\x52\x32_FN_…'、'disabled\x5fat'
    //   都能让 F1～F5 在源码文本上的名字匹配看不见
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const raw = text.slice(node.getStart(sf), node.end);
      const m = badEscape(raw);
      if (m) bad(node, `字符串里不准写转义 ${m.replace(/[\r\n]/, '换行')}（只准 \\n \\r \\t \\b \\f \\v \\0 \\\\ \\' \\" \\\` \\$）：\\x、\\u、八进制、续行、\\_ 这类写法让值和源码原文不同，F1～F5 的名字匹配看不见`);
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && BAD_STRINGS.has(node.text)) {
      bad(node, `字符串 '${node.text}' 不准出现（拿来当属性名就能绕开 Deno、process、globalThis 的检查）`);
      return;
    }
    // 第七轮必改 1：普通函数（function 声明 / 表达式、对象字面量里的方法）里不准用 this——调用方式决定 this，可能拿到全局对象；
    //   箭头函数穿透到外层；类的方法、构造器、属性初始化里放行；模块顶层的 this 是 undefined，放行
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      for (let c = node.parent; c && !ts.isSourceFile(c); c = c.parent) {
        if (ts.isArrowFunction(c)) continue;
        if (ts.isFunctionDeclaration(c) || ts.isFunctionExpression(c)) { bad(node, '普通函数（function）里不准用 this：this 由调用方式决定，可能拿到全局对象（只准类的方法里用，或改用箭头函数 / 参数）'); return; }
        if (ts.isMethodDeclaration(c) || ts.isGetAccessorDeclaration(c) || ts.isSetAccessorDeclaration(c) || ts.isConstructorDeclaration(c) || ts.isPropertyDeclaration(c) || ts.isClassStaticBlockDeclaration(c)) {
          if (!c.parent || !(ts.isClassDeclaration(c.parent) || ts.isClassExpression(c.parent))) bad(node, '对象字面量的方法里不准用 this（只准类的方法里用）');
          return;
        }
      }
      return;
    }
    // 第八轮必改 ②：对象展开 { ...x } 的 x 同上
    if (ts.isSpreadAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
      if (!rules || rules.argAnyish(node.expression)) bad(node, '对象展开 { ...x } 的 x 类型不准是 any、unknown、object、{} 或 EventTarget 这类：看不出拷贝的是什么对象');
      return;
    }
    // 第四轮必改 1（c2）：方括号取值。属性名是拼出来的（'De' + 'no'、`${a}b`）一律报；属性名不是字面量、取出来马上调用的（x[k](…)）也报。
    //   方括号里放一个变量、不马上调用的写法 AST 判断不了它的值，见 check_backend.py 文件头“剩余风险”
    if (ts.isElementAccessExpression(node)) {
      const k = node.argumentExpression;
      // 字符串拼接：+ 的某一边（一路往下）是字符串字面量或模板；数组下标的数字运算（bytes[i + 1]）不算
      const strPart = (e) => ts.isParenthesizedExpression(e) ? strPart(e.expression)
        : isLit(e) || ts.isTemplateExpression(e) || (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken && (strPart(e.left) || strPart(e.right)));
      const concat = (e) => ts.isParenthesizedExpression(e) ? concat(e.expression)
        : ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken && strPart(e);
      if (concat(k) || ts.isTemplateExpression(k)) bad(node, '方括号里的属性名不准是拼出来的（\'De\' + \'no\'、带 ${} 的模板），看不出取的是什么');
      // 第五轮（剩余风险①选项乙）+ 第六轮：键走 keyProblem（类型、追字面量、断言回查、白名单）
      else if (rules) checkKey(node, k, node.expression, node, '方括号里的属性名：');
      else if (!isLit(k) && !ts.isNumericLiteral(k) && ts.isCallExpression(node.parent) && node.parent.expression === node) {
        // 没有类型检查器时退回第四轮的句法规则：不是字面量、取出来马上调用的（同时整份文件另报一条“类型检查器建不起来”，见文件末尾）
        bad(node, '方括号里不是字面量的属性取出来马上调用（x[k](…)）不准用：k 可能是拼出来的 constructor，等于 Function 构造器');
      }
      return;
    }
    // 解构里的计算键 { [k]: v } = …（d7）：同一条规则
    if (ts.isComputedPropertyName(node) && ts.isBindingElement(node.parent)) {
      const k = node.expression;
      if (rules) checkKey(node, k, null, node.parent.name, '解构的计算键 { [k]: … }：');
      else if (!isLit(k) && !ts.isNumericLiteral(k)) bad(node, '解构的计算键 { [k]: … } 不是字面量，类型检查器又建不起来，宁可报错不放行');
      return;
    }
    // 第六轮必改 3：Reflect.get / has / set / getOwnPropertyDescriptor…、Object.getOwnPropertyDescriptor / defineProperty 的键参数走同一条规则；
    //   Reflect.apply / construct 的第一个参数只准是静态的函数；Object.getOwnPropertyDescriptors 禁用。globalThis.Reflect.get 这类也算
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const ex = node.expression.expression;
      const owner = ts.isIdentifier(ex) ? ex.text : ts.isPropertyAccessExpression(ex) ? ex.name.text : '';
      const callee = `${owner}.${node.expression.name.text}`;
      const spread = node.arguments.some((a) => ts.isSpreadElement(a));
      if (BANNED_FNS.has(callee)) bad(node, `${callee} 一律禁用（一次拿到全部属性描述，没有键可查）`);
      else if (ENUM_FNS.has(callee)) {
        // 第七轮必改 1：参数类型是 any / unknown 的报（看不出遍历 / 拷贝的是什么对象）
        if (spread || !rules || node.arguments.some((a) => rules.argAnyish(a))) bad(node, `${callee} 的参数类型不准是 any、unknown、object、{} 或 EventTarget 这类（也不准 ...展开）：看不出遍历、拷贝的是什么对象`);
      }
      else if (KEY_FNS.has(callee)) {
        const k = node.arguments[1];
        if (spread || !k) bad(node, `${callee} 的参数不准用 ...展开或省略键（看不出取的是哪个属性）`);
        else if (rules) checkKey(node, k, node.arguments[0], node, `${callee} 的键参数：`);
        else if (!isLit(k) && !ts.isNumericLiteral(k)) bad(node, `${callee} 的键参数不是字面量，类型检查器又建不起来，宁可报错不放行`);
      } else if (APPLY_FNS.has(callee)) {
        const f = node.arguments[0];
        if (spread || !f || !rules || !rules.staticFn(f)) bad(node, `${callee} 的第一个参数只准是本文件里的函数声明或 const 名 = 箭头函数 / 函数表达式（动态拿到的函数可能是 Function 构造器）`);
      }
    }
    if (!ts.isIdentifier(node)) return;
    const raw = text.slice(node.getStart(sf), node.end);
    if (raw.includes('\\')) bad(node, '标识符里不准写反斜杠 u 转义（D\\u0065no 这类写法让名字匹配看不见）');
    const name = node.text;
    // 属性访问的名字（x.Deno）按整个 x.Deno 看后面跟什么；其余位置按标识符本身看
    const p = node.parent;
    const v = p && ts.isPropertyAccessExpression(p) && p.name === node ? p : node;

    if (BANNED.has(name)) {
      bad(node, `${name} 一律禁用（eval、Function、require、createRequire 都能不写字面量就拿到 Deno、process 或任意模块）`);
      return;
    }
    if (BANNED_PROTO.has(name)) {
      bad(node, name === 'Worker' || name === 'SharedWorker'
        ? `${name} 一律禁用（Worker 里能跑任意代码、照样拿得到 Deno，F1～F7 都查不了）`
        : `${name} 一律禁用（.constructor、__proto__、getPrototypeOf 能拿到 Function 构造器，不写 Function 就能执行任意代码）`);
      return;
    }
    // 第六轮必改 3：Reflect 只准直接调用 Reflect.方法(…)（存进变量、解构、方括号、?. 都能绕开上面的调用检查）；
    //   Object 只准跟 .名字，按键取属性的那几个方法只准直接调用。类型位置（x: Object、typeof Reflect）不管
    if (name === 'Reflect' || name === 'Object') {
      if (p && (ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p) || ts.isExpressionWithTypeArguments(p) || ts.isQualifiedName(p))) return;
      // 简写属性 { Reflect } 会把 Reflect 当值带走，不算属性名，照查（第九轮低 1）
      if (p && v === node && 'name' in p && p.name === node && !ts.isShorthandPropertyAssignment(p)) return;   // 声明 / 属性名本身（{ Object: 1 }）
      const d = dotAfter(v);
      const called = d && ts.isCallExpression(d.parent) && d.parent.expression === d && !d.parent.questionDotToken;
      if (name === 'Reflect' && !called) { bad(node, 'Reflect 只准直接调用 Reflect.方法(…)：存进变量、解构、方括号取值、?. 都能绕开键参数的检查'); return; }
      if (name === 'Object') {
        if (!d) { bad(node, 'Object 只准跟 .名字（Object.keys 这类）：存进变量、解构、方括号取值都能绕开 getOwnPropertyDescriptor 等的检查'); return; }
        const m = `Object.${d.name.text}`;
        if ((KEY_FNS.has(m) || BANNED_FNS.has(m)) && !called) { bad(node, `${m} 只准直接调用（存进变量再调就查不了键参数）`); return; }
      }
      return;
    }
    if (name === 'Deno') {
      const env = dotAfter(v);
      if (env && env.name.text === 'serve' && ts.isCallExpression(env.parent) && env.parent.expression === env) return;
      if (env && env.name.text === 'env') {
        const m = dotAfter(env);
        const call = m && ts.isCallExpression(m.parent) && m.parent.expression === m && !m.parent.questionDotToken ? m.parent : undefined;
        if (call && (m.name.text === 'get' || m.name.text === 'has') && call.arguments.length === 1) {
          const a = call.arguments[0];
          if (isLit(a) && rawIsValue(a)) return;
          if (fnRel === '_shared/db.ts' && m.name.text === 'get' && ts.isElementAccessExpression(a) && isName(a.expression, 'URL_ENV') && isName(a.argumentExpression, 'role')) return;
        }
      }
      bad(node, "Deno 只准写 Deno.env.get('名字') / Deno.env.has('名字')（一个不带转义的字面量）或 Deno.serve(…)：Deno?.env、解构、存进变量、当参数传、方括号取值、toObject() 都看不出读的是哪个 secret，F1～F3 查不了");
      return;
    }
    if (name === 'process') {
      if (p && ts.isImportClause(p) && p.name === node) return;   // import process from '…'（spec 由 check_backend.py 查）
      const d = dotAfter(v);
      if (d && d.name.text !== 'env') return;   // process.exit 这类
      if (d) {
        const pp = d.parent;
        if (ts.isPropertyAccessExpression(pp) && pp.expression === d && !pp.questionDotToken) return;   // process.env.名字
        if (ts.isElementAccessExpression(pp) && pp.expression === d && !pp.questionDotToken && isLit(pp.argumentExpression) && rawIsValue(pp.argumentExpression)) return;   // process.env['名字']（不带转义，见 rawIsValue）
      }
      bad(node, "process 只准写 process.env.名字、process.env['名字']（不带转义的字面量）或 process.别的属性：process?.env、解构、存进变量、当参数传、方括号取值、整个拿走都看不出读的是哪个 secret，F1～F3 查不了");
      return;
    }
    // 第八轮必改 ①：全局的事件监听 / 派发（不带对象前缀，或挂在 globalThis / self / window 上）一律禁用——事件对象能带出全局对象
    if (EVENT_FNS.has(name)) {
      // 简写属性 { addEventListener } 同上，照查（第九轮低 1）
      if (v === node && p && 'name' in p && p.name === node && !ts.isShorthandPropertyAssignment(p)) return;   // 声明的名字（类方法、对象属性）本身不算
      const owner = v !== node ? v.expression : null;
      let o = owner;
      while (o && (ts.isParenthesizedExpression(o) || ASSERT(o))) o = o.expression;
      // 不带前缀的：名字确实指向全局才报（同名的局部变量、参数不算；没有类型检查器时一律报）
      if ((!owner && (!rules || rules.isGlobalName(node))) || (o && ts.isIdentifier(o) && (GLOBALS.has(o.text) || aliases.has(o.text)))) {
        bad(node, `全局的 ${name} 不准用（不带对象前缀、或 globalThis / self / window. 上的）：事件对象能带出全局对象；要监听请用具体对象的方法`);
        return;
      }
    }
    // 第八轮低：全局事件属性 onunhandledrejection、onerror、onload…——给它赋值就能拿到全局事件（事件对象带得出全局对象），读取也不准
    if (EVENT_PROPS.has(name)) {
      // 简写属性 { onunhandledrejection } 读的是同名变量的值，不算声明，照查（第九轮低 1）
      if (v === node && p && 'name' in p && p.name === node && !ts.isShorthandPropertyAssignment(p)) return;   // 声明的名字本身（局部变量、参数、属性名）
      const owner = v !== node ? v.expression : null;
      let o = owner;
      while (o && (ts.isParenthesizedExpression(o) || ASSERT(o))) o = o.expression;
      const bare = !owner && (!rules || rules.isGlobalName(node));
      if (bare || (o && ts.isIdentifier(o) && (GLOBALS.has(o.text) || aliases.has(o.text)))) {
        bad(node, `全局事件属性 ${name} 不准用（不带对象前缀、或 globalThis / self / window. 上的，赋值、读取都算）：全局事件对象能带出全局对象`);
        return;
      }
    }
    if (GLOBALS.has(name) || aliases.has(name)) {
      if (v !== node) return;   // x.globalThis：属性名不是全局对象本身（取到的东西另由上面的 Deno、process 规则管）
      if (aliases.has(name) && p && ts.isVariableDeclaration(p) && p.name === node) return;   // 别名的声明本身
      if (dotAfter(node)) return;
      if (dotAfter(unwrapUp(node))) return;   // (globalThis as T).EdgeRuntime 这类：穿过括号、类型断言后还是 .标识符，安全
      if (GLOBALS.has(name)) {
        // 别名白名单：const 名 = globalThis as …（只在登记的文件、登记的名字）
        const up = unwrapUp(node);
        if (up !== node && ts.isVariableDeclaration(up.parent) && up.parent.initializer === up && ts.isIdentifier(up.parent.name) && aliases.has(up.parent.name.text)) return;
        const call = up.parent;
        if (call && ts.isCallExpression(call) && call.arguments[0] === up && ts.isPropertyAccessExpression(call.expression)) {
          const callee = `${call.expression.expression.getText(sf)}.${call.expression.name.text}`;
          if (callee === 'Reflect.get' || callee === 'Object.getOwnPropertyDescriptor') {
            bad(node, `${callee} 的第一个参数不准是 ${name}（可以用拼出来的名字取到 Deno、process）`);
            return;
          }
        }
      }
      bad(node, `${name} 只准跟 .标识符（${name}.setTimeout 这类）：不准当参数传、存进变量、方括号取值、?.（都能用拼出来的名字取到 Deno、process）`);
    }
  };

  visit(sf);
  return { code, imports, findings, parseError };
}

const input = JSON.parse(readFileSync(0, 'utf8'));

// 第五轮（剩余风险①选项乙）：把要查 F7 的文件（supabase/functions 的源码）建成一个 program，拿类型检查器判键类型。
//   第六轮低 5：建不起来时退回第四轮的句法规则，同时给每个 F7 文件报一条错（宁可报错不放行）；program 里找不到某个文件也报
let program = null, checker = null, rules = null, progErr = null;
const f7paths = input.files.filter((f) => f.f7).map((f) => f.path);
if (f7paths.length) {
  try {
    const opts = {
      allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, skipDefaultLibCheck: true,
      target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true, noResolve: false, strict: false,
    };
    // 第六轮：npm:包@版本 映射到仓库根 node_modules 里的同名包（版本由 deno-config 测试保证和 package.json 一致），
    //   否则 zod 这类全成 any，键的“值类型不能是 any”判不准
    const host = ts.createCompilerHost(opts);
    const repoPkg = fileURLToPath(new URL('../package.json', import.meta.url));
    host.resolveModuleNames = (names, containing) => names.map((n) => {
      const m = /^npm:((?:@[^/@]+\/)?[^/@]+)(?:@[^/]*)?(\/.*)?$/.exec(n);
      return ts.resolveModuleName(m ? m[1] + (m[2] ?? '') : n, m ? repoPkg : containing, opts, host).resolvedModule;
    });
    program = ts.createProgram(f7paths, opts, host);
    checker = program.getTypeChecker();
    rules = makeKeyRules(checker);
  } catch (e) { program = checker = rules = null; progErr = e instanceof Error ? e.message : String(e); }
}
// 测试开关（同上，只会更严）：模拟 program 建不起来
if (process.env.CHECK_BACKEND_FAIL_PROGRAM) { program = checker = rules = null; progErr = '测试用：CHECK_BACKEND_FAIL_PROGRAM'; }

const result = {};
for (const f of input.files) {
  try {
    const own = f.f7 && program && !program.getSourceFile(f.path) ? null : rules;
    result[f.rel] = analyse(f.path, f.rel, f.f7, f.fnRel ?? null, f.f7 ? own : null, f.f7 ? program : null);
    if (f.f7 && !own) {
      result[f.rel].findings.unshift({ line: 1, message: `类型检查器建不起来（${progErr ?? 'program 里没有这个文件'}），键类型检查退回句法规则；宁可报错不放行，修好后再跑` });
    }
  } catch (e) {
    result[f.rel] = { code: '', imports: [], findings: [], parseError: `解析器出错：${e instanceof Error ? e.message : e}` };
  }
}
process.stdout.write(JSON.stringify(result));
