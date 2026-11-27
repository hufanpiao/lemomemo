// build/check_arch.py BINIMPORT 的实现一侧（B1 接手清单 LINT-binimport；11-14 CI-10 整理：原先是 check_arch.py 里约 660 行的手写词法器，
// 改成 JS/TS 用 TypeScript 编译器 API 解析成 AST（AST 小工具和 build/check_backend_ast.mjs 共用 build/ts_ast.mjs），非 JS 入口只查下面列的几处）。
// 用法：node build/check_binimport.mjs < 输入.json > 输出.json（只由 check_arch.py 调用）
//   输入：{ "root": 仓库根, "binExt": [二进制扩展名…], "files": [相对路径…] }（文件清单同 BIDI：git ls-files，不在 git 里就整棵树；
//   先按扩展名挑出要扫的文件再读内容，别的文件不读）
//   输出：[{ "file", "line", "message" }]
// 守的事：会被当代码执行的目标不准是二进制扩展名（Node 的 CJS 把不认识的扩展名当 JS 执行，解释器把文件当源码跑；
// 二进制在 git 和 GitHub 里看不到内容，里面藏的代码评审在 diff 里看不到）。
// ① JS/TS（.ts .tsx .mts .cts .js .jsx .mjs .cjs）：import / export … from / import = require / import() / require（含 x.require、x['require']、
//    .call / .apply、Reflect.apply / Reflect.construct、?.()、(0, require)()）/ importScripts / new Worker、SharedWorker，以及读文件再执行的
//    eval、Function、vm.runIn*、vm.compileFunction、vm.Script、process.dlopen——这些调用的参数里任何一个字符串表达式以二进制扩展名结尾就报。
//    字符串表达式先常量折叠（build/ts_ast.mjs 的 litText）：'./p.pn' + 'g' 两边都是字符串就拼起来；模板里能折叠的插值代回去
//    （`./t.bi${'n'}`），代不回去的按空串；一边是变量的 + 不折，两边的字面量各自核对。
//    别名：上面这些名字和 createRequire 的别名（import { createRequire as cr }、{ require: r } = …、const r = require、r = eval，
//    别名的别名跟到不再变）一样认；createRequire 的调用结果绑到的名字（变量、解构、赋值、对象属性、类属性、.then 回调参数）和
//    createRequire(…)(…) 连写都当 require。注释、普通字符串里的假 import 不报。
//    例外只有一种：src/ 下（Vite 打包）的 import / export … from / import() 用普通字符串引图片并带 ?url 或 ?inline。
//    目标字符串超过 4096 个字符不核对、按可疑报；解析时出错（嵌套深到解析器栈溢出）整个文件按可疑报。
//    属性名是 command 的字符串（playwright*.config.ts 的 webServer.command 这类）当命令行，按 ② 的规则查。
// ② 非 JS 入口里 node、python、bash、pwsh 等命令执行的文件（-r / --require / --import / --loader / --preload 的值也算；sh -c '…' 里接着找）
//    和命令开头的 source、点号。扫这几处（11-14 核对过本仓库调解释器的全部入口）：
//      package.json 的 scripts、根目录 deno.json / deno.jsonc 的 tasks（字符串或 { command }）、.yml / .yaml 的 run:、.sh / .bash、
//      .ps1 / .psm1、JS/TS 里属性名是 command 的字符串、.html 的 <script src>。
//    Makefile、.py 的 os.system、.bat、.vue 等不扫，以后加了这类入口要在这里补。
// 剩余风险：路径经变量间接传进去的（const p = './x.bin'; require(p)、函数参数、对象取值、运行时拼接）静态堵不住，靠代码审查；
//    别名只按名字认，经对象、数组、函数返回值转手的（const o = { r: require }; o.r(…)）认不出。
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { children, kindOf, litText, unwrap, walk } from './ts_ast.mjs';

const SPEC_MAX = 4096;
const JS_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const VITE_ASSET_OK = /^[^?#]*\.(?:png|jpe?g|gif|webp|avif|ico|bmp)\?(?:url|inline)$/i;
const LOADERS = new Set(['require', 'importScripts', 'Worker', 'SharedWorker']);
const EXEC = new Set(['eval', 'Function', 'runInThisContext', 'runInNewContext', 'runInContext', 'compileFunction', 'dlopen']);
const FACTORY = 'createRequire';
const NAMES = [...LOADERS, ...EXEC, FACTORY];

let BIN_EXT = [];
/** 目标以二进制扩展名结尾就返回扩展名：原文、去掉 ? 之后、去掉 # 之后任一种命中都算 */
function binExt(spec) {
  const s = spec.trim().toLowerCase();
  for (const v of [s, s.split('?')[0], s.split('#')[0], s.split('?')[0].split('#')[0]]) {
    const hit = BIN_EXT.find((e) => v.endsWith(e));
    if (hit) return hit;
  }
  return null;
}
const entryMessage = (h) => `${h.how} 执行的文件是二进制扩展名 ${binExt(h.target)}：${h.target.slice(0, 80)}（解释器把文件当源码执行，二进制里藏的代码评审在 diff 里看不到）`;

// ───────── ① JS/TS ─────────
/** 属性名：x.名字、x?.名字、x['名字']（方括号里是能折叠的字符串） */
const propName = (n) => (ts.isPropertyAccessExpression(n) ? n.name.text : ts.isElementAccessExpression(n) ? litText(n.argumentExpression) : undefined);
/** 名字：标识符本身，或属性名 */
const nameOf = (n) => (ts.isIdentifier(n) ? n.text : propName(n));
/** 对象字面量、解构、import 的键名（标识符或字符串） */
const keyText = (k) => (k && (ts.isIdentifier(k) || ts.isStringLiteral(k)) ? k.text : undefined);
const bindingNames = (b) => (ts.isIdentifier(b) ? [b.text] : [...walk(b)].filter((x) => ts.isIdentifier(x) && ts.isBindingElement(x.parent) && x.parent.name === x).map((x) => x.text));
const arrayTargets = (a) => [...walk(a)].filter(ts.isIdentifier).map((x) => x.text);
const isAssign = (n) => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken;

/**
 * 加载、执行函数（LOADERS、EXEC、createRequire）的别名，和 createRequire 调用结果绑到的名字（都按名字认，只会多报：
 * 多收的名字只有拿二进制扩展名的字符串去调时才报）。aliases：名字 → 原名（原名自己也在里面）
 */
function bindings(sf, text) {
  const aliases = new Map(NAMES.map((n) => [n, n]));
  const bound = new Set();
  const none = { aliases, bound, isFactoryCall: () => false };
  // 一个名字都没写就没有别名和绑定可收，整段跳过（绝大多数文件）
  if (!NAMES.some((n) => text.includes(n))) return none;
  const nodes = [...walk(sf)];
  const originOf = (e) => {
    const n = nameOf(unwrap(e));
    return n === undefined ? undefined : aliases.get(n);
  };
  // 别名：import { createRequire as cr }、const { require: r } = …、const r = require、r = eval（别名的别名跟到不再变）
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of nodes) {
      let alias, origin;
      if ((ts.isImportSpecifier(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name) && n.propertyName) {
        const from = keyText(n.propertyName);
        if (from !== undefined) [alias, origin] = [n.name.text, aliases.get(from)];
      } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) [alias, origin] = [n.name.text, originOf(n.initializer)];
      else if (isAssign(n) && ts.isIdentifier(unwrap(n.left))) [alias, origin] = [unwrap(n.left).text, originOf(n.right)];
      if (alias && origin && !aliases.has(alias)) {
        aliases.set(alias, origin);
        changed = true;
      }
    }
  }
  if (![...aliases.values()].includes(FACTORY) || !text.includes(FACTORY)) return none;
  const isFactoryRef = (e) => originOf(e) === FACTORY;
  const isFactoryCall = (e) => {
    const u = unwrap(e);
    return ts.isCallExpression(u) && isFactoryRef(u.expression);
  };
  const hasFactoryCall = (e) => {
    for (const x of walk(e)) if (ts.isCallExpression(x) && isFactoryRef(x.expression)) return true;
    return false;
  };
  for (const n of nodes) {
    if (ts.isVariableDeclaration(n) && n.initializer && hasFactoryCall(n.initializer)) bindingNames(n.name).forEach((x) => bound.add(x));
    else if (isAssign(n) && hasFactoryCall(n.right)) {
      const l = unwrap(n.left);
      if (ts.isIdentifier(l) || ts.isPropertyAccessExpression(l)) bound.add(nameOf(l));
      else if (ts.isArrayLiteralExpression(l)) arrayTargets(l).forEach((x) => bound.add(x));
    } else if ((ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n)) && n.initializer && hasFactoryCall(n.initializer) && ts.isIdentifier(n.name)) bound.add(n.name.text);
    else if (ts.isCallExpression(n) && propName(n.expression) === 'then' && hasFactoryCall(n.expression.expression)) {
      const cb = n.arguments[0] && unwrap(n.arguments[0]);
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters[0]) bindingNames(cb.parameters[0].name).forEach((x) => bound.add(x));
    }
  }
  for (const x of aliases.keys()) bound.delete(x);
  bound.delete('import');
  return { aliases, bound, isFactoryCall };
}

/** 被调用的函数会不会把参数当代码加载、执行：返回写法（报错里用），不是返回 undefined */
function calleeHow(callee, fb) {
  const c = unwrap(callee);
  if (fb.isFactoryCall(c)) return 'createRequire(…)()';
  if (propName(c) === 'Script' && nameOf(unwrap(c.expression)) === 'vm') return 'vm.Script()';
  const name = nameOf(c);
  if (name === undefined) return undefined;
  const origin = fb.aliases.get(name);
  if (origin && origin !== FACTORY) return origin === name ? `${name}()` : `${name}()（${origin} 的别名）`;
  if (fb.bound.has(name)) return `createRequire 得到的 ${name}()`;
  return undefined;
}

/** 这个调用（call 或 new）会不会把参数当代码加载、执行 */
function loaderHow(call, fb) {
  const c = unwrap(call.expression);
  if (c.kind === ts.SyntaxKind.ImportKeyword) return 'import()';
  const p = propName(c);
  // Reflect.apply(require, null, ['./x.bin'])、Reflect.construct(Worker, ['./x.bin'])：第一个参数是被调用的函数
  if ((p === 'apply' || p === 'construct') && nameOf(unwrap(c.expression)) === 'Reflect') {
    const how = call.arguments[0] && calleeHow(call.arguments[0], fb);
    return how ? `Reflect.${p}(${how})` : undefined;
  }
  return calleeHow(p === 'call' || p === 'apply' ? c.expression : c, fb);
}

function checkJs(rel, text, out) {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kindOf(rel));
  const fb = bindings(sf, text);
  const lineAt = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const seen = new Set();
  const report = (node, how) => {
    if (seen.has(node.pos)) return;
    const spec = litText(node);
    const line = lineAt(node.getStart(sf));
    if (spec.length > SPEC_MAX) {
      seen.add(node.pos);
      out.push({ file: rel, line, message: `${how} 的目标字符串长 ${spec.length} 个字符，超过 ${SPEC_MAX}，不核对扩展名、按可疑报：${spec.slice(0, 80)}（真实的模块路径不会这么长，拆短或改成普通字符串）` });
      return;
    }
    const ext = binExt(spec);
    if (!ext) return;
    const viteImport = (how === 'import()' || how === 'import/export … from') && ts.isStringLiteral(node);
    if (viteImport && rel.startsWith('src/') && VITE_ASSET_OK.test(spec)) return;
    seen.add(node.pos);
    out.push({ file: rel, line, message: `${how} 的目标是二进制扩展名 ${ext}：${spec.slice(0, 80)}（Node 的 CJS 把不认识的扩展名当 JS 执行，二进制里藏的代码评审在 diff 里看不到；src/ 下 Vite 引图片要写 ?url 或 ?inline）` });
  };
  // 每个节点带着“在哪种加载调用的参数里”往下走；参数里的每个字符串表达式（含嵌套、三元）折叠后核对一次，折叠过的里面不再分开核对
  const stack = [[sf, undefined]];
  while (stack.length) {
    const [n, ctx] = stack.pop();
    let inner = ctx;
    if (ctx && litText(n) !== undefined) {
      report(n, ctx);
      inner = undefined;
    }
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) report(n.moduleSpecifier, 'import/export … from');
    if (ts.isExternalModuleReference(n) && n.expression) report(n.expression, 'import = require()');
    // 属性名是 command 的字符串：当命令行查（行号按命令在字符串里的位置往下数）
    if (ts.isPropertyAssignment(n) && keyText(n.name) === 'command') {
      const cmd = litText(n.initializer);
      if (cmd !== undefined) {
        const line0 = lineAt(n.initializer.getStart(sf));
        for (const h of shellHits(cmd, true)) out.push({ file: rel, line: line0 + (cmd.slice(0, h.at).match(/\n/g)?.length ?? 0), message: entryMessage(h) });
      }
    }
    const how = ts.isCallExpression(n) || ts.isNewExpression(n) ? loaderHow(n, fb) : undefined;
    const args = new Set(how ? n.arguments : []);
    const kids = children(n);
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push([kids[i], args.has(kids[i]) ? how : inner]);
  }
}

// ───────── ② 非 JS 入口 ─────────
const INTERP = /^(?:node|nodejs|bun|deno|tsx|ts-node|python(?:[23](?:\.\d+)?)?|py|bash|sh|zsh|dash|pwsh|powershell)(?:\.exe)?$/i;
const NODE_CMDS = new Set(['node', 'nodejs', 'bun', 'deno', 'tsx', 'ts-node']);
const SH_CMDS = new Set(['bash', 'sh', 'zsh', 'dash']);
const VALUE_OPTS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--preload']);
const SKIP_VALUE_OPTS = new Set(['-W', '-X', '--max-old-space-size', '--stack-size', '--title', '--input-type', '--env-file']);
const NODE_SKIP_VALUE_OPTS = new Set(['-C', '--conditions']);
const CODE_OPTS = new Set(['-e', '--eval', '-p', '--print', '-c', '-m']);
const PS_FILE_OPTS = new Set(['-file', '-f']);
const PS_CODE_OPTS = new Set(['-command', '-c', '-encodedcommand', '-e', '-ec']);
const PS_SKIP_VALUE_OPTS = new Set(['-executionpolicy', '-ep', '-ex', '-windowstyle', '-w', '-workingdirectory', '-wd', '-configurationname', '-config',
  '-outputformat', '-of', '-o', '-inputformat', '-if', '-in', '-version', '-v', '-psconsolefile', '-settingsfile', '-custompipename']);
const KEYWORDS = new Set(['then', 'do', 'else', 'if', 'elif', 'while', 'until', '!', 'time']);

/**
 * 把一段命令行切成一条条命令：[[{ w, at, quoted }]]。at 是词在 text 里的下标。
 * 分隔：换行、; & | < > ) 反引号、$(、单独成词的 { }；引号里不分；escapes 为真时反斜杠转义下一个字符（反斜杠换行是续行），
 * PowerShell 不认反斜杠（Windows 路径）。# 开头的词到行尾是注释
 */
function commands(text, escapes) {
  const cmds = [[]];
  let w = null;
  const end = () => {
    if (w && (w.quoted || w.w !== '{' && w.w !== '}')) cmds[cmds.length - 1].push(w);
    else if (w) cmds.push([]);
    w = null;
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (escapes && c === '\\') {
      if (text[i + 1] === '\n' || text.startsWith('\r\n', i + 1)) { i += text[i + 1] === '\r' ? 2 : 1; continue; }
      w ??= { w: '', at: i, quoted: false };
      w.w += text[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      w ??= { w: '', at: i, quoted: false };
      w.quoted = true;
      const close = text.indexOf(c, i + 1);
      const stop = close < 0 ? text.length : close;
      w.w += text.slice(i + 1, stop);
      i = stop;
      continue;
    }
    if (c === '#' && !w) { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl - 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { end(); continue; }
    if (c === '$' && text[i + 1] === '(') { end(); cmds.push([]); i += 1; continue; }
    if ('\n;&|<>)`'.includes(c)) { end(); cmds.push([]); continue; }
    w ??= { w: '', at: i, quoted: false };
    w.w += c;
  }
  end();
  return cmds.filter((x) => x.length);
}

/** 一条命令里被执行的文件：[{ at, how, target }]；sh -c '…' 的代码接着切 */
function cmdHits(cmd, escapes, out) {
  let k = 0;
  while (k < cmd.length && !cmd[k].quoted && KEYWORDS.has(cmd[k].w)) k += 1;
  const first = cmd[k];
  if (first && !first.quoted && (first.w === '.' || first.w === 'source')) {
    const t = cmd[k + 1];
    if (t && !t.w.startsWith('-') && binExt(t.w)) out.push({ at: t.at, how: `命令 ${first.w}`, target: t.w });
    return;
  }
  for (let i = k; i < cmd.length; i += 1) {
    const word = cmd[i];
    const base = word.w.split(/[\\/]/).pop() ?? '';
    if (word.quoted || !INTERP.test(base)) continue;
    const name = base.toLowerCase().replace(/\.exe$/, '');
    const ps = name === 'pwsh' || name === 'powershell';
    const hit = (t) => { if (binExt(t.w)) { out.push({ at: t.at, how: `命令 ${base}`, target: t.w }); return true; } return false; };
    for (let j = i + 1; j < cmd.length; j += 1) {
      const t = cmd[j];
      if (!t.w.startsWith('-') || t.quoted) {
        // deno run / bun run 的子命令；落单的数字是前面不认识的选项的值（--max-old-space-size 4096）
        if ((t.w === 'run' && (name === 'deno' || name === 'bun')) || /^\d+$/.test(t.w)) continue;
        hit(t);
        return;
      }
      const sep = ps && t.w.includes(':') ? ':' : '=';
      const [opt0, ...rest] = t.w.split(sep);
      const opt = ps ? opt0.toLowerCase() : opt0;
      const val = rest.length ? { w: rest.join(sep), at: t.at + opt0.length + 1 } : cmd[j + 1];
      if (ps ? PS_CODE_OPTS.has(opt) : CODE_OPTS.has(opt)) {
        if (SH_CMDS.has(name) && opt === '-c' && val) for (const c of commands(val.w, escapes)) cmdHits(c.map((x) => ({ ...x, at: val.at })), escapes, out);
        return;
      }
      if (ps ? PS_FILE_OPTS.has(opt) : VALUE_OPTS.has(opt)) {
        if (val && hit(val)) return;
        if (ps) return; // -File 的值就是脚本，后面是脚本自己的参数
        if (!rest.length) j += 1;
        continue;
      }
      const skip = ps ? PS_SKIP_VALUE_OPTS : new Set([...SKIP_VALUE_OPTS, ...(NODE_CMDS.has(name) ? NODE_SKIP_VALUE_OPTS : [])]);
      if (skip.has(opt) && !rest.length) j += 1;
    }
    return;
  }
}

function shellHits(text, escapes, base = 0) {
  const out = [];
  for (const c of commands(text, escapes)) cmdHits(c, escapes, out);
  return out.map((h) => ({ ...h, at: h.at + base }));
}

/** JSON 根对象第一层 key（package.json 的 scripts、deno.json 的 tasks）里的每条命令；值是字符串，或 { command }（deno 的任务对象）。
 *  行号记在键所在的那一行。jsonc 为真时（deno.json、deno.jsonc 都许写注释、尾逗号）严格 JSON 解析不了再按 TypeScript 读配置文件的规则解析；
 *  解析不了（含嵌套深到栈溢出）的不报：工具自己也读不了，任务跑不起来 */
function jsonCommandHits(text, key, jsonc = false) {
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    if (!jsonc) return [];
    try {
      config = ts.parseConfigFileTextToJson('x.jsonc', text).config;
    } catch {
      return [];
    }
  }
  const table = config?.[key];
  if (!table || typeof table !== 'object') return [];
  const from = Math.max(0, text.indexOf(`"${key}"`));
  return Object.entries(table).flatMap(([k, v]) => {
    const cmd = typeof v === 'string' ? v : typeof v?.command === 'string' ? v.command : undefined;
    if (cmd === undefined) return [];
    const at = text.indexOf(JSON.stringify(k), from);
    return shellHits(cmd, true).map((h) => ({ ...h, at: Math.max(at, 0) }));
  });
}

/** YAML 的 run:（GitHub Actions，本仓库只有这一种命令键）：同一行的值，或 | / > 块里比键缩进更深的各行 */
function yamlHits(text) {
  const out = [];
  const lines = text.split('\n');
  let pos = 0;
  for (let i = 0; i < lines.length; pos += lines[i].length + 1, i += 1) {
    const m = /^(\s*)(?:-\s+)?run:[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const value = m[2].replace(/\s+#.*$/, '');
    if (/^[|>][-+0-9]*\s*$/.test(value)) {
      let end = pos + lines[i].length + 1;
      for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || /^\s*/.exec(lines[j])[0].length > m[1].length); j += 1) end += lines[j].length + 1;
      out.push(...shellHits(text.slice(pos + lines[i].length + 1, end), true, pos + lines[i].length + 1));
      continue;
    }
    const q = /^(["'])(.*)\1$/.exec(value.trim());
    const start = pos + lines[i].length - m[2].length + (q ? m[2].indexOf(q[2]) : 0);
    out.push(...shellHits(q ? q[2] : value, true, start));
  }
  return out;
}

const SCRIPT_SRC = /<script\b[^>]{0,1000}?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
function htmlHits(text) {
  const out = [];
  for (const m of text.matchAll(SCRIPT_SRC)) {
    const g = [1, 2, 3].find((k) => m[k] !== undefined);
    if (binExt(m[g])) out.push({ at: m.index + m[0].lastIndexOf(m[g]), how: '<script src>', target: m[g] });
  }
  return out;
}

/** 按路径挑非 JS 入口的扫法；不是要扫的入口返回 null（不读内容） */
function entryScanner(rel) {
  const low = rel.toLowerCase();
  if (low === 'package.json' || low.endsWith('/package.json')) return (t) => jsonCommandHits(t, 'scripts');
  if (low === 'deno.json' || low === 'deno.jsonc') return (t) => jsonCommandHits(t, 'tasks', true);
  if (/\.ya?ml$/.test(low)) return yamlHits;
  if (/\.(?:sh|bash)$/.test(low)) return (t) => shellHits(t, true);
  if (/\.ps[m]?1$/.test(low)) return (t) => shellHits(t, false);
  if (/\.html?$/.test(low)) return htmlHits;
  return null;
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  BIN_EXT = input.binExt;
  const out = [];
  for (const rel of input.files) {
    const js = JS_EXT.test(rel);
    const scan = js ? null : entryScanner(rel);
    if (!js && !scan) continue;
    const text = readFileSync(join(input.root, rel)).toString('utf8');
    if (js) {
      try {
        checkJs(rel, text, out);
      } catch (e) {
        out.push({ file: rel, line: 1, message: `解析不了（${String(e?.message ?? e).slice(0, 80)}），不核对、整个文件按可疑报（多半是嵌套深到解析器栈溢出）` });
      }
      continue;
    }
    const hits = scan(text);
    if (!hits.length) continue;
    const starts = ts.computeLineStarts(text);
    for (const h of hits) out.push({ file: rel, line: ts.computeLineAndCharacterOfPosition(starts, h.at).line + 1, message: entryMessage(h) });
  }
  process.stdout.write(JSON.stringify(out));
}

main();
