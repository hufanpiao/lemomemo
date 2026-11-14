// build/check_arch.py BINIMPORT 的实现一侧（B1 接手清单 LINT-binimport；11-14 CI-10 整理：原先是 check_arch.py 里约 660 行的手写词法器，
// 改成 JS/TS 用 TypeScript 编译器 API 解析成 AST（同 build/check_backend_ast.mjs 的做法），非 JS 入口只查本仓库调解释器的那几处）。
// 用法：node build/check_binimport.mjs < 输入.json > 输出.json（只由 check_arch.py 调用）
//   输入：{ "root": 仓库根, "binExt": [二进制扩展名…], "files": [相对路径…] }（文件清单同 BIDI：git ls-files，不在 git 里就整棵树）
//   输出：[{ "file", "line", "message" }]
// 守的事：会被当代码执行的目标不准是二进制扩展名（Node 的 CJS 把不认识的扩展名当 JS 执行，解释器把文件当源码跑；
// 二进制在 git 和 GitHub 里看不到内容，里面藏的代码评审在 diff 里看不到）。
// ① JS/TS（.ts .tsx .mts .cts .js .jsx .mjs .cjs）：import / export … from / import = require / import() / require（含 x.require、
//    .call / .apply、?.()、(0, require)()）/ importScripts / new Worker、SharedWorker，以及读文件再执行的 eval、Function、vm.runIn*、
//    vm.compileFunction、vm.Script、process.dlopen——这些调用的参数里任何一个字符串（拼接、模板去掉 ${…} 后）以二进制扩展名结尾就报；
//    createRequire 的别名（import { createRequire as cr }、{ createRequire: cr }、const cr = createRequire）、它的调用结果绑到的名字
//    （变量、解构、赋值、对象属性、类属性、.then 回调参数）和 createRequire(…)(…) 连写都当 require。注释、普通字符串里的假 import 不报。
//    例外只有一种：src/ 下（Vite 打包）的 import / export … from / import() 用普通字符串引图片并带 ?url 或 ?inline。
//    目标字符串超过 4096 个字符不核对、按可疑报；解析时出错（嵌套深到解析器栈溢出）整个文件按可疑报。
// ② 非 JS 入口：package.json 的 scripts、.yml / .yaml 的 run:、.sh / .bash、.ps1 / .psm1 里 node、python、bash、pwsh 等命令执行的文件
//    （-r / --require / --import / --loader / --preload 的值也算；sh -c '…' 里接着找）和命令开头的 source、点号；.html 的 <script src>。
//    本仓库调解释器只有这几处（11-14 核对）；Makefile、.py 的 os.system、.bat、.vue 等不再扫，以后加了这类入口要在这里补。
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SPEC_MAX = 4096;
const JS_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const VITE_ASSET_OK = /^[^?#]*\.(?:png|jpe?g|gif|webp|avif|ico|bmp)\?(?:url|inline)$/i;
const LOADERS = new Set(['require', 'importScripts', 'Worker', 'SharedWorker']);
const EXEC = new Set(['eval', 'Function', 'runInThisContext', 'runInNewContext', 'runInContext', 'compileFunction', 'dlopen']);
const FACTORY = 'createRequire';

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

// ───────── ① JS/TS ─────────
const kindOf = (p) => (/\.tsx$/i.test(p) ? ts.ScriptKind.TSX : /\.[cm]?ts$/i.test(p) ? ts.ScriptKind.TS : /\.jsx$/i.test(p) ? ts.ScriptKind.JSX : ts.ScriptKind.JS);
/** 跳过括号、类型断言、非空断言、逗号表达式（取最后一项：(0, require)） */
function unwrap(n) {
  for (;;) {
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n)) n = n.expression;
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.CommaToken) n = n.right;
    else return n;
  }
}
/** 名字：标识符本身、x.名字 / x?.名字 的属性名 */
const nameOf = (n) => (ts.isIdentifier(n) ? n.text : ts.isPropertyAccessExpression(n) ? n.name.text : undefined);
function children(n) {
  const out = [];
  n.forEachChild((c) => { out.push(c); });
  return out;
}
/** 显式栈的前序遍历（不递归：深嵌套的代码不会把栈撑爆） */
function* walk(root) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    yield n;
    const kids = children(n);
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
}
const bindingNames = (b) => (ts.isIdentifier(b) ? [b.text] : [...walk(b)].filter((x) => ts.isIdentifier(x) && ts.isBindingElement(x.parent) && x.parent.name === x).map((x) => x.text));
const arrayTargets = (a) => [...walk(a)].filter(ts.isIdentifier).map((x) => x.text);

/** createRequire 的别名和它调用结果绑到的名字（按名字认，只会多报：多收的名字只有拿二进制扩展名的字符串去调时才报） */
function factoryBindings(sf) {
  const factories = new Set([FACTORY]);
  const nodes = [...walk(sf)];
  const isFactoryRef = (e) => { const n = nameOf(unwrap(e)); return n !== undefined && factories.has(n); };
  const isFactoryCall = (e) => { const u = unwrap(e); return ts.isCallExpression(u) && isFactoryRef(u.expression); };
  const hasFactoryCall = (e) => { for (const x of walk(e)) if (ts.isCallExpression(x) && isFactoryRef(x.expression)) return true; return false; };
  // 别名：import { createRequire as cr }、const { createRequire: cr } = …、const cr = createRequire（别名的别名跟到不再变）
  for (let changed = true; changed;) {
    changed = false;
    for (const n of nodes) {
      let alias;
      if ((ts.isImportSpecifier(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name)) {
        const from = n.propertyName && ts.isIdentifier(n.propertyName) ? n.propertyName.text : undefined;
        if (from && factories.has(from)) alias = n.name.text;
      } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isFactoryRef(n.initializer)) alias = n.name.text;
      if (alias && !factories.has(alias)) { factories.add(alias); changed = true; }
    }
  }
  const bound = new Set();
  for (const n of nodes) {
    if (ts.isVariableDeclaration(n) && n.initializer && hasFactoryCall(n.initializer)) bindingNames(n.name).forEach((x) => bound.add(x));
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && hasFactoryCall(n.right)) {
      const l = unwrap(n.left);
      if (ts.isIdentifier(l) || ts.isPropertyAccessExpression(l)) bound.add(nameOf(l));
      else if (ts.isArrayLiteralExpression(l)) arrayTargets(l).forEach((x) => bound.add(x));
    } else if ((ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n)) && n.initializer && hasFactoryCall(n.initializer) && ts.isIdentifier(n.name)) bound.add(n.name.text);
    else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'then' && hasFactoryCall(n.expression.expression)) {
      const cb = n.arguments[0] && unwrap(n.arguments[0]);
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters[0]) bindingNames(cb.parameters[0].name).forEach((x) => bound.add(x));
    }
  }
  for (const x of [...LOADERS, ...EXEC, 'import']) bound.delete(x);
  return { bound, isFactoryCall };
}

/** 这个调用会不会把参数当代码加载、执行：返回写法（报错里用），不是返回 undefined */
function loaderHow(callee, fb) {
  let c = unwrap(callee);
  if (c.kind === ts.SyntaxKind.ImportKeyword) return 'import()';
  if (ts.isPropertyAccessExpression(c) && (c.name.text === 'call' || c.name.text === 'apply')) c = unwrap(c.expression);
  if (fb.isFactoryCall(c)) return 'createRequire(…)()';
  if (ts.isPropertyAccessExpression(c) && c.name.text === 'Script' && ts.isIdentifier(c.expression) && c.expression.text === 'vm') return 'vm.Script()';
  const name = nameOf(c);
  if (name === undefined) return undefined;
  if (LOADERS.has(name) || EXEC.has(name)) return `${name}()`;
  if (fb.bound.has(name)) return `createRequire 得到的 ${name}()`;
  return undefined;
}

/** 字符串类字面量的值（模板去掉 ${…}）；不是字符串返回 undefined */
function litText(n) {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => s.literal.text).join('');
  return undefined;
}

function checkJs(rel, text, out) {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kindOf(rel));
  // 没写 createRequire 这个词就没有别名和绑定可收，整段跳过（绝大多数文件）
  const fb = text.includes(FACTORY) ? factoryBindings(sf) : { bound: new Set(), isFactoryCall: () => false };
  const seen = new Set();
  const report = (lit, how) => {
    if (seen.has(lit.pos)) return;
    const spec = litText(lit);
    const line = sf.getLineAndCharacterOfPosition(lit.getStart(sf)).line + 1;
    if (spec.length > SPEC_MAX) {
      seen.add(lit.pos);
      out.push({ file: rel, line, message: `${how} 的目标字符串长 ${spec.length} 个字符，超过 ${SPEC_MAX}，不核对扩展名、按可疑报：${spec.slice(0, 80)}（真实的模块路径不会这么长，拆短或改成普通字符串）` });
      return;
    }
    const ext = binExt(spec);
    if (!ext) return;
    const viteImport = (how === 'import()' || how === 'import/export … from') && ts.isStringLiteral(lit);
    if (viteImport && rel.startsWith('src/') && VITE_ASSET_OK.test(spec)) return;
    seen.add(lit.pos);
    out.push({ file: rel, line, message: `${how} 的目标是二进制扩展名 ${ext}：${spec.slice(0, 80)}（Node 的 CJS 把不认识的扩展名当 JS 执行，二进制里藏的代码评审在 diff 里看不到；src/ 下 Vite 引图片要写 ?url 或 ?inline）` });
  };
  // 每个节点带着“在哪种加载调用的参数里”往下走；参数里的每个字符串（含嵌套、拼接、三元）都核对
  const stack = [[sf, undefined]];
  while (stack.length) {
    const [n, ctx] = stack.pop();
    if (ctx && litText(n) !== undefined) report(n, ctx);
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) report(n.moduleSpecifier, 'import/export … from');
    if (ts.isExternalModuleReference(n) && n.expression) report(n.expression, 'import = require()');
    const how = ts.isCallExpression(n) || ts.isNewExpression(n) ? loaderHow(n.expression, fb) : undefined;
    const args = new Set(how ? n.arguments : []);
    const kids = children(n);
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push([kids[i], args.has(kids[i]) ? how : ctx]);
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

/** package.json 根对象第一层 scripts 里的每条命令；行号记在键所在的那一行 */
function packageHits(text) {
  let scripts;
  try { scripts = JSON.parse(text)?.scripts; } catch { return []; }
  if (!scripts || typeof scripts !== 'object') return [];
  const from = Math.max(0, text.indexOf('"scripts"'));
  return Object.entries(scripts).flatMap(([k, v]) => {
    if (typeof v !== 'string') return [];
    const at = text.indexOf(JSON.stringify(k), from);
    return shellHits(v, true).map((h) => ({ ...h, at: Math.max(at, 0) }));
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

function entryHits(rel, text) {
  const low = rel.toLowerCase();
  if (low === 'package.json' || low.endsWith('/package.json')) return packageHits(text);
  if (/\.ya?ml$/.test(low)) return yamlHits(text);
  if (/\.(?:sh|bash)$/.test(low)) return shellHits(text, true);
  if (/\.ps[m]?1$/.test(low)) return shellHits(text, false);
  if (/\.html?$/.test(low)) return htmlHits(text);
  return null;
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  BIN_EXT = input.binExt;
  const out = [];
  for (const rel of input.files) {
    const text = readFileSync(join(input.root, rel)).toString('utf8');
    if (JS_EXT.test(rel)) {
      try {
        checkJs(rel, text, out);
      } catch (e) {
        out.push({ file: rel, line: 1, message: `解析不了（${String(e?.message ?? e).slice(0, 80)}），不核对、整个文件按可疑报（多半是嵌套深到解析器栈溢出）` });
      }
      continue;
    }
    const hits = entryHits(rel, text);
    if (!hits?.length) continue;
    const starts = ts.computeLineStarts(text);
    for (const h of hits) {
      const line = ts.computeLineAndCharacterOfPosition(starts, h.at).line + 1;
      out.push({ file: rel, line, message: `${h.how} 执行的文件是二进制扩展名 ${binExt(h.target)}：${h.target.slice(0, 80)}（解释器把文件当源码执行，二进制里藏的代码评审在 diff 里看不到）` });
    }
  }
  process.stdout.write(JSON.stringify(out));
}

main();
