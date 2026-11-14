// 架构 2.3 的三条引入限制（11-14 CI-11 从 build/check_arch.py 的正则检查挪来，源码层只在这里查一份）。
// 认的写法：import … from、export … from、只写路径的 import 'x'、import x = require('x')、require('x') 算静态；import('x') 算动态；
// 来源要是字符串（或不带 ${} 的反引号）。import type / export type … from（整句只引类型，编译后不留）单独标出；import { type X } 不算纯类型
// （verbatimModuleSyntax 下会留下 import 'x'），import type from 'x' 是默认导入起名叫 type，也不算。注释里的不算（按 AST 认）。
//   R2：src 里不准引对象存储的任何东西：shared/objstore.ts、aws4fetch、functions/ 下的文件（含生成的 files-rules）。
//       App 只经 platform/files.ts 调同源的 /files/v1/*（架构 0.32 第 2、4 条，任务单 FA-2）
//   LUNAR：src 里不准静态引入农历数据和换算（shared/logic/anniv/lunar*），只许 import() 按需加载（架构 2.6：农历单独 chunk、不进入口）；
//       间接的也报：src 静态引入 shared/ 的模块，它再经静态引入（隔几层都算，只跟相对路径、只在 shared/ 里走）走到农历模块；
//       中间任何一层用 import() 或 import type 就算断开（B1 接手清单 LUNAR-indirect-import）。产物层另由 build/check_first_paint_chunks.mjs 兜底
//   MOTION-IMPL：motion、framer-motion、motion-dom、motion-utils（含子路径）只能在 src/motion/*-impl.tsx 里引入（src/motion/ 下的纯类型放行）；
//       指向 src/motion/*-impl.tsx 的引入：静态的只准别的 *-impl.tsx 写，import() 只准 src/motion/features.ts 写。
//       src/motion/__tests__/ 和 src/motion/ 下的 *.test.ts(x) 不管（架构 2.3 MOTION-IMPL、2.6，R-354）
// 路径按仓库根算：默认从本文件位置推（build/eslint-rules/ 往上两层），不用 ESLint 的 cwd（11-14 整块评审：在子目录里跑 eslint 时 cwd 不是仓库根，
// src/ 判断全错、规则悄悄不报）；样例测试用选项 ['error', { root }] 指到迷你仓库。相对路径解析到 root 外或解析不到的跳过。
// 相对路径按 TS 的写法解析：./x.js 也找 x.ts、x.tsx，./x.mjs 找 x.mts，./x.cjs 找 x.cts；不带扩展名的依次试 RESOLVE_EXT 和 index.*
// 不许给 lint 加 --cache（eslint.config.js 和 package.json 的 lint 同样写明，tests/build/workflow-permissions.test.ts 断言）：LUNAR 间接那条
// 要读别的文件（shared/ 里一层层往下跟），ESLint 的缓存只按本文件内容判断要不要重查，shared/ 改了、src 没改时会沿用旧结果漏报
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESOLVE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs'];
/** 写的是 JS 扩展名时，TS 源码可能的扩展名 */
const TS_FOR_JS = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
const LUNAR_RE = /(^|\/)logic\/anniv\/lunar[^/]*$/;
const MOTION_PKG_RE = /^(motion|framer-motion|motion-dom|motion-utils)(\/.*)?$/;
const MOTION_IMPL_FILE_RE = /^src\/motion\/[^/]+-impl\.tsx$/;
const MOTION_FEATURES = 'src/motion/features.ts';

const strOf = (n) => (n?.type === 'Literal' && typeof n.value === 'string' ? n.value : n?.type === 'TemplateLiteral' && n.expressions.length === 0 ? n.quasis[0].value.cooked : undefined);

/** 一个文件里所有写死来源的引入：{ spec, dynamic, typeOnly, node } */
function refsOf(ast) {
  const out = [];
  const add = (src, dynamic, typeOnly) => {
    const spec = strOf(src);
    if (spec !== undefined) out.push({ spec: spec.replace(/\\/g, '/'), dynamic, typeOnly, node: src });
  };
  const stack = [ast];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n.type !== 'string') continue;
    if (n.type === 'ImportDeclaration') add(n.source, false, n.importKind === 'type');
    else if ((n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && n.source) add(n.source, false, n.exportKind === 'type');
    else if (n.type === 'ImportExpression') add(n.source, true, false);
    else if (n.type === 'TSExternalModuleReference') add(n.expression, false, n.parent?.importKind === 'type');
    else if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require') add(n.arguments[0], false, false);
    for (const [k, v] of Object.entries(n)) {
      if (k === 'parent') continue;
      if (Array.isArray(v)) for (const c of v) stack.push(c);
      else if (v && typeof v === 'object') stack.push(v);
    }
  }
  return out;
}

const posix = (p) => p.replace(/\\/g, '/');
const isLunar = (spec) => LUNAR_RE.test(spec.replace(/\.ts$/, ''));

/** 相对路径的引入解析成 root 里的文件（返回相对 root 的路径）；npm 包、解析不到、出了 root 的返回 undefined */
function resolveRel(root, fromFile, spec) {
  const s = spec.split('?')[0];
  if (!s.startsWith('.')) return undefined;
  const base = resolve(dirname(fromFile), s);
  const cands = [base];
  for (const [js, tsExts] of Object.entries(TS_FOR_JS)) if (base.endsWith(js)) cands.push(...tsExts.map((e) => base.slice(0, -js.length) + e));
  cands.push(...RESOLVE_EXT.map((e) => base + e), ...RESOLVE_EXT.map((e) => resolve(base, `index${e}`)));
  for (const c of cands) {
    if (!existsSync(c) || !statSync(c).isFile()) continue;
    const r = relative(root, c);
    return r.startsWith('..') || isAbsolute(r) ? undefined : posix(r);
  }
  return undefined;
}

/** 依赖文件的引入（按修改时间缓存解析结果） */
const parsed = new Map();
function refsOfFile(path) {
  const mtime = statSync(path).mtimeMs;
  const hit = parsed.get(path);
  if (hit && hit.mtime === mtime) return hit.refs;
  const { ast } = tseslint.parser.parseForESLint(readFileSync(path, 'utf8'), { sourceType: 'module', ecmaVersion: 'latest', ecmaFeatures: { jsx: path.endsWith('.tsx') } });
  const refs = refsOf(ast).map(({ spec, dynamic, typeOnly }) => ({ spec, dynamic, typeOnly }));
  parsed.set(path, { mtime, refs });
  return refs;
}

/** shared/ 里的 rel 经静态引入（隔几层都算）能不能走到农历模块：能就返回经过的路径（最后一项是农历模块） */
function lunarChain(root, rel, seen) {
  if (seen.has(rel)) return undefined;
  seen.add(rel);
  for (const r of refsOfFile(resolve(root, rel))) {
    if (r.dynamic || r.typeOnly) continue;
    if (isLunar(r.spec)) return [r.spec];
    const next = resolveRel(root, resolve(root, rel), r.spec);
    if (!next?.startsWith('shared/')) continue;
    if (isLunar(next)) return [next]; // 同目录的 './lunar.ts' 写法，按解析后的路径认
    const sub = lunarChain(root, next, seen);
    if (sub) return [next, ...sub];
  }
  return undefined;
}

function r2Forbidden(spec) {
  if (/^(npm:)?aws4fetch(@[^/]*)?(\/|$)/.test(spec)) return 'aws4fetch';
  if (/(^|\/)shared\/objstore(\.ts)?$/.test(spec)) return 'shared/objstore.ts';
  if (/^(\.\.\/)+functions\//.test(spec) || spec.includes('_generated/files-rules')) return 'functions/ 下的文件（Pages Functions、生成的规则表）';
  return undefined;
}

const motionTestExempt = (rel) => rel.startsWith('src/motion/') && (rel.includes('/__tests__/') || /\.test\.tsx?$/.test(rel));

export default {
  meta: {
    type: 'problem',
    docs: { description: '架构 2.3 R2、LUNAR、MOTION-IMPL：对象存储、农历、动画库的引入限制' },
    schema: [{ type: 'object', properties: { root: { type: 'string' } }, additionalProperties: false }],
  },
  create(context) {
    const root = resolve(context.options[0]?.root ?? REPO_ROOT);
    const file = context.filename;
    const rel = posix(relative(root, file));
    const inSrc = rel.startsWith('src/');
    if (!inSrc && !rel.startsWith('shared/')) return {};
    return {
      Program(ast) {
        for (const r of refsOf(ast)) {
          const report = (message) => context.report({ node: r.node, message });
          if (inSrc) {
            const what = r2Forbidden(r.spec);
            if (what) report(`R2：App 不准 import 对象存储的东西（${what}）：照片和附件一律经 platform/files.ts 调 /files/v1/*`);
            if (!r.dynamic && !r.typeOnly) {
              if (isLunar(r.spec)) {
                report(`LUNAR：农历数据只能按需加载：把 ${r.spec} 改成 await import('…')（单独 chunk，不进入口，架构 2.6）`);
              } else {
                const target = resolveRel(root, file, r.spec);
                const chain = target?.startsWith('shared/') ? lunarChain(root, target, new Set()) : undefined;
                if (chain) {
                  report(`LUNAR：间接静态引入了农历（${[target, ...chain].join(' → ')}）：农历会打进首屏。在 src 里改成 await import('${r.spec}')，`
                    + '或让 shared 那一层对农历只用 import()（架构 2.6，B1 接手清单 LUNAR-indirect-import）');
                }
              }
            }
          }
          if (motionTestExempt(rel)) continue;
          const inMotion = rel.startsWith('src/motion/');
          if (r.spec.startsWith('./') || r.spec.startsWith('../')) {
            const target = resolveRel(root, file, r.spec);
            if (!target || !MOTION_IMPL_FILE_RE.test(target)) continue;
            const ok = r.typeOnly ? inMotion : r.dynamic ? rel === MOTION_FEATURES : MOTION_IMPL_FILE_RE.test(rel);
            if (!ok) report(`MOTION-IMPL：动画实现 ${r.spec} 只能由 src/motion/features.ts 用 import() 动态加载（别的 *-impl.tsx 可以静态引）：静态引入会把 motion/react 带进首屏（架构 2.6、17.3，R-354）`);
            continue;
          }
          if (!MOTION_PKG_RE.test(r.spec) || MOTION_IMPL_FILE_RE.test(rel) || (r.typeOnly && inMotion)) continue;
          report(`MOTION-IMPL：只有 src/motion/*-impl.tsx 能引入 ${r.spec}：要用 motion 的代码写进 src/motion/ 下的 *-impl.tsx、由 motion-impl.tsx 导出，`
            + '对外给只依赖 react 的门面；只要类型就写 import type（只限 src/motion/）（架构 2.6、17.3，R-354）');
        }
      },
    };
  },
};
