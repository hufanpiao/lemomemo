// A26：JSX 里原生元素的 href、src 等只能是字符串常量、路由函数 hrefOf() 或 safeHref() 的返回值（架构 2.3，第二轮安全 N9）
// 只管小写开头的原生元素（<a>、<img>、<iframe>…）；自己的组件在组件内部落到原生元素时再检查
// A26-import：只认从 shared/logic/link.ts 导入的 safeHref、从 src/app/router.ts 导入的 hrefOf（按导入语句和作用域认，
//   不按函数名认；别名导入、命名空间导入都认；router.ts、link.ts 自己文件里定义的那个也认）。本地同名函数、别处导入的同名函数都不算
//   来源路径只认 .ts、不带扩展名、.js（指向 .ts）三种写法；router.tsx、link.mjs、link.tsx 这类同名兄弟文件不算
// A26-spread：原生元素上的展开属性也查。对象字面量逐个键查；键名算不出来（计算键、嵌套展开）或展开的是变量（{...props}），
//   静态看不出有没有 href，一律报
// 属性名比较不分大小写（HREF、formaction、srcset、xlink:HREF 都算）：React 只拦写法完全正确的 href、formAction，
//   别的大小写原样落到 DOM，浏览器照样当链接用
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 链接类属性：全小写、去掉冒号后比较（src/motion/Pressable.tsx 的 LINK_KEYS 是同一张表，两边一起改） */
const URL_ATTRS = new Set(['href', 'src', 'srcset', 'action', 'formaction', 'poster', 'data', 'xlinkhref']);
const isUrlAttr = (name) => URL_ATTRS.has(name.toLowerCase().replace(':', ''));
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 合法函数名 → 唯一合法来源文件（仓库根相对路径，不带 .ts） */
const SAFE_SOURCES = new Map([
  ['safeHref', 'shared/logic/link'],
  ['hrefOf', 'src/app/router'],
]);

/** 统一分隔符；Windows 不分大小写 */
function canon(abs) {
  const p = abs.replace(/\\/g, '/');
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** import 写的路径 → 指向的 .ts 文件（去掉扩展名后的形式）；只认 .ts、不带扩展名、.js 三种，别的扩展名返回 undefined */
function importTarget(abs) {
  const ext = extname(abs);
  if (ext === '') return canon(abs);
  if (ext === '.ts' || ext === '.js') return canon(abs.slice(0, -ext.length));
  return undefined;
}

const SAFE_FILES = new Map([...SAFE_SOURCES].map(([fn, rel]) => [fn, canon(resolve(ROOT, rel))]));

function attrName(n) {
  if (n.type === 'JSXIdentifier') return n.name;
  if (n.type === 'JSXNamespacedName') return `${n.namespace.name}:${n.name.name}`;
  return '';
}

/** 对象字面量里的键名（原样返回，比较时再转小写）；算不出来返回 undefined */
function propKey(p) {
  if (!p.computed && p.key.type === 'Identifier') return p.key.name;
  if (p.key.type === 'Literal' && (typeof p.key.value === 'string' || typeof p.key.value === 'number')) return String(p.key.value);
  if (p.key.type === 'TemplateLiteral' && p.key.expressions.length === 0) return p.key.quasis[0].value.cooked;
  return undefined;
}

function isNativeElement(opening) {
  const el = opening.name;
  return el.type === 'JSXIdentifier' && /^[a-z]/.test(el.name) ? el.name : undefined;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'A26：href、src 只能是常量、hrefOf() 或 safeHref()（只认从指定文件导入的那个）' },
    schema: [],
    messages: {
      unsafe: 'A26：<{{el}}> 的 {{attr}} 只能是字符串常量、hrefOf() 或 safeHref() 的返回值（safeHref 要从 shared/logic/link.ts 导入，hrefOf 要从 src/app/router.ts 导入）',
      unsafeSpread: 'A26：<{{el}}> 上的展开属性看不出有没有 href、src 等链接属性；原生元素上请直接写属性，链接值只能是字符串常量、hrefOf() 或 safeHref() 的返回值',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const filename = context.filename;
    // 自家文件的豁免只给真正的 router.ts、link.ts
    const selfFile = extname(filename) === '.ts' ? canon(resolve(filename).slice(0, -3)) : undefined;

    /** 这个 import 语句的来源是不是 fn 的合法来源文件 */
    function fromSafeSource(importDecl, fn) {
      if (!importDecl || importDecl.type !== 'ImportDeclaration' || importDecl.importKind === 'type') return false;
      const src = importDecl.source.value;
      if (typeof src !== 'string' || !src.startsWith('.')) return false;
      const target = importTarget(resolve(dirname(filename), src));
      return target !== undefined && target === SAFE_FILES.get(fn);
    }

    /** 按作用域找到这个标识符真正指向的变量 */
    function resolveVar(id) {
      for (let scope = sourceCode.getScope(id); scope; scope = scope.upper) {
        const ref = scope.references.find((r) => r.identifier === id);
        if (ref) return ref.resolved;
      }
      return null;
    }

    /** callee 是不是从合法来源导入的 safeHref / hrefOf */
    function isSafeCallee(c) {
      if (c.type === 'Identifier') {
        const v = resolveVar(c);
        const def = v?.defs[0];
        if (!def || v.defs.length !== 1) return false;
        if (def.type === 'ImportBinding' && def.node.type === 'ImportSpecifier' && def.node.importKind !== 'type') {
          const imported = def.node.imported.type === 'Identifier' ? def.node.imported.name : def.node.imported.value;
          return SAFE_SOURCES.has(imported) && fromSafeSource(def.parent, imported);
        }
        // router.ts、link.ts 自己文件里定义的那个
        if (def.type === 'FunctionName' && v.scope.type === 'module' && selfFile !== undefined && SAFE_FILES.get(c.name) === selfFile) return true;
        return false;
      }
      // 命名空间导入：import * as link from '…/shared/logic/link.ts'; link.safeHref(x)
      if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier' && c.object.type === 'Identifier') {
        const fn = c.property.name;
        if (!SAFE_SOURCES.has(fn)) return false;
        const v = resolveVar(c.object);
        const def = v?.defs[0];
        if (!def || v.defs.length !== 1) return false;
        return def.type === 'ImportBinding' && def.node.type === 'ImportNamespaceSpecifier' && fromSafeSource(def.parent, fn);
      }
      return false;
    }

    function isSafe(expr) {
      if (expr.type === 'Literal' && typeof expr.value === 'string') return true;
      if (expr.type === 'TemplateLiteral' && expr.expressions.length === 0) return true;
      if (expr.type === 'CallExpression') return isSafeCallee(expr.callee);
      return false;
    }

    return {
      JSXAttribute(node) {
        const attr = attrName(node.name);
        if (!isUrlAttr(attr)) return;
        const el = isNativeElement(node.parent);
        if (!el) return;
        const v = node.value;
        if (!v || v.type === 'Literal') return;
        if (v.type === 'JSXExpressionContainer' && isSafe(v.expression)) return;
        context.report({ node, messageId: 'unsafe', data: { el, attr } });
      },
      JSXSpreadAttribute(node) {
        const el = isNativeElement(node.parent);
        if (!el) return;
        const arg = node.argument;
        if (arg.type !== 'ObjectExpression') {
          context.report({ node, messageId: 'unsafeSpread', data: { el } });
          return;
        }
        for (const p of arg.properties) {
          const key = p.type === 'Property' ? propKey(p) : undefined;
          if (key === undefined) {
            context.report({ node: p, messageId: 'unsafeSpread', data: { el } });
            continue;
          }
          if (!isUrlAttr(key)) continue;
          if (p.value && isSafe(p.value)) continue;
          context.report({ node: p, messageId: 'unsafe', data: { el, attr: key } });
        }
      },
    };
  },
};
