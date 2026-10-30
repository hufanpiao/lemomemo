// A26：JSX 里原生元素的 href、src 等只能是字符串常量、路由函数 hrefOf() 或 safeHref() 的返回值（架构 2.3，第二轮安全 N9）
// 只管小写开头的原生元素（<a>、<img>、<iframe>…）；自己的组件在组件内部落到原生元素时再检查
// A26-import：只认从 shared/logic/link.ts 导入的 safeHref、从 src/app/router.ts 导入的 hrefOf（按导入语句和作用域认，
//   不按函数名认；别名导入、命名空间导入都认；router.ts、link.ts 自己文件里定义的那个也认）。本地同名函数、别处导入的同名函数都不算
//   来源路径只认写全 .ts 后缀的（架构 2.5）：不带扩展名、写 .js 的都不算（同目录有 link.mjs、link.js 时 Vite 加载的是那个冒牌文件），
//   router.tsx、link.mjs、link.tsx 这类同名兄弟文件也不算
// A26-import-ext（A26-old-gaps ⑥，10-30）：上面那些写法不光在用到的地方不算，来源本身也单独报——
//   import / export … from / import() 的相对路径指向 shared/logic/link 或 src/app/router，但不是正好写成 “….ts”
//   （不带扩展名、.js、.mjs、.cjs、.tsx、.jsx、.mts、.cts、大写 .TS、带 ?query 或 #hash），就在来源字符串上报 importExt；
//   只导入不用、转出口给别人用的也拦得住。纯类型导入（import type）编译后不存在，不管
// A26-spread：原生元素上的展开属性也查。对象字面量逐个键查；键名算不出来（计算键、嵌套展开）或展开的是变量（{...props}），
//   静态看不出有没有 href，一律报
// A26-template（FE-1030-sugg ④）：动态 import 的来源写成模板串也查——不带插值的按字面量查；带插值、又可能指向
//   shared/logic/link 或 src/app/router 的（把插值当任意文字，能拼出指向它们的相对路径），静态核对不了，直接报 importDynamic。
//   “可能指向”要满足其一：静态部分里写出了 link 或 router；或者第一段插值前的前缀已经落在 shared/logic/、src/app/ 目录里
// A26-scheme（A26-old-gaps ④）：链接类属性写成常量（字符串、不带插值的模板串）也过一遍协议：先照浏览器的做法去掉首尾的
//   控制字符和空格、删掉中间的制表符和换行，再看开头：
//   · 带 scheme 的照 shared/logic/link.ts 的 safeHref 判：new URL 解析不了、协议不是 http、https、tel、mailto、
//     带用户名或密码（https://lemomemo.com@evil.com）的都报 badScheme；
//   · 以 //、\\、/\ 开头的协议相对地址报（会去别的站；safeHref 不带 base 解析，本来也不放行）；
//   · 别的相对地址（/app/x、?q=1、#a、./a.png）照 A26 原来的口径当常量放行——只有这一处比 safeHref 宽
//     （safeHref 管的是用户输入的文字，相对地址一律不认）
// 属性名比较不分大小写（HREF、formaction、srcset、xlink:HREF 都算）：React 只拦写法完全正确的 href、formAction，
//   别的大小写原样落到 DOM，浏览器照样当链接用
import { dirname, extname, relative, resolve } from 'node:path';
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

/** import 写的路径 → 指向的 .ts 文件（去掉 .ts 后的形式）；只认写全 .ts 后缀的（架构 2.5），别的一律返回 undefined */
function importTarget(abs) {
  return extname(abs) === '.ts' ? canon(abs.slice(0, -3)) : undefined;
}

const SAFE_FILES = new Map([...SAFE_SOURCES].map(([fn, rel]) => [fn, canon(resolve(ROOT, rel))]));
const SAFE_TARGETS = new Set(SAFE_FILES.values());

/** 脚本类扩展名（不分大小写）：去掉它（或本来就没有扩展名）以后再和 link、router 比 */
const SCRIPT_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

/** 这个相对路径是不是指向 link / router（不管扩展名怎么写），而且没有正好写成 .ts */
function wrongSafeSpelling(src, fromFile) {
  if (typeof src !== 'string' || !src.startsWith('.')) return false;
  const bare = src.split(/[?#]/)[0] ?? '';
  const abs = resolve(dirname(fromFile), bare);
  const m = SCRIPT_EXT.exec(abs);
  if (!SAFE_TARGETS.has(canon(m ? abs.slice(0, -m[0].length) : abs))) return false;
  return bare !== src || extname(abs) !== '.ts';
}

/** 常量链接允许的协议（shared/logic/link.ts 的 ALLOWED 是同一张表，两边一起改） */
const ALLOWED_SCHEMES = new Set(['http', 'https', 'tel', 'mailto']);

/** 照 URL 标准预处理：去掉首尾码位 ≤ 0x20 的字符，删掉中间的 \t、\n、\r */
function stripLikeUrlParser(text) {
  let a = 0;
  let b = text.length;
  while (a < b && text.charCodeAt(a) <= 0x20) a += 1;
  while (b > a && text.charCodeAt(b - 1) <= 0x20) b -= 1;
  let out = '';
  for (const ch of text.slice(a, b)) if (ch !== '\t' && ch !== '\n' && ch !== '\r') out += ch;
  return out;
}

/** 常量链接不安全的原因；安全（相对地址，或带 scheme 且过得了 safeHref 的规则）返回 undefined */
function badScheme(text) {
  // 浏览器解析 URL 时：去掉首尾的 C0 控制字符和空格，删掉所有制表符和换行（java\tscript: 照样是 javascript:）
  const s = stripLikeUrlParser(text);
  // 协议相对地址：浏览器把 \ 当 / 看，//、\\、/\、\/ 开头都会去别的主机
  if (/^[/\\]{2}/.test(s)) return '协议相对地址（//…）';
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (!m) return undefined;
  // 带 scheme：和 safeHref 同一套判断（new URL 解析、协议白名单、不带用户名和密码）
  let url;
  try {
    url = new URL(s);
  } catch {
    return '解析不了的地址';
  }
  if (!ALLOWED_SCHEMES.has(url.protocol.slice(0, -1))) return `协议 ${url.protocol}`;
  if (url.username !== '' || url.password !== '') return '带用户名或密码的地址';
  return undefined;
}

/** srcset 是逗号分开的多个“地址 宽度”，每个地址都查；别的属性整串查 */
function badSchemeOf(attr, text) {
  if (attr.toLowerCase() !== 'srcset') return badScheme(text);
  for (const part of text.split(',')) {
    const bad = badScheme(part.trim().split(/\s+/)[0] ?? '');
    if (bad !== undefined) return bad;
  }
  return undefined;
}

/** 字符串字面量、不带插值的模板串 → 它的值；别的返回 undefined */
function staticString(expr) {
  if (!expr) return undefined;
  if (expr.type === 'Literal' && typeof expr.value === 'string') return expr.value;
  if (expr.type === 'TemplateLiteral' && expr.expressions.length === 0) return expr.quasis[0].value.cooked ?? undefined;
  return undefined;
}

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** link、router 所在的目录（canon 过） */
const SAFE_DIRS = [...SAFE_SOURCES.values()].map((rel) => canon(dirname(resolve(ROOT, rel))));

/**
 * 模板串第一段插值前的静态前缀，按目录部分（最后一个 / 之前）解析后是不是已经落在 shared/logic/ 或 src/app/ 里（含子目录）。
 * 落在里面的，插值拼成什么都可能指向 link、router（${'li' + 'nk'} 这类拼接认不出字面），照样套相对路径去查
 */
function prefixInSafeDir(prefix, fromFile) {
  if (!prefix.startsWith('.')) return false;
  const cut = prefix.lastIndexOf('/');
  const dir = canon(resolve(dirname(fromFile), cut < 0 ? '.' : prefix.slice(0, cut + 1)));
  return SAFE_DIRS.some((d) => dir === d || dir.startsWith(`${d}/`));
}

/**
 * 带插值的模板串来源会不会指向 link / router：插值里是字符串常量的照常量拼进去，别的插值当任意文字；? 或 # 以后是查询串、不管。
 * 静态部分里要真的出现 link 或 router（整段都是插值的 import(`${x}`) 看不出指向哪里，和 import(变量) 一样不管，
 * 免得 import(`./${lang}.ts`) 这类普通加载器被误报），再拿“从本文件到 link、router 的相对路径”
 * （带或不带 ./、各种脚本扩展名）去套，能套上就算
 */
function templateMayPointToSafe(tpl, fromFile) {
  const parts = [''];
  let cut = false;
  const push = (text) => {
    const at = text.search(/[?#]/);
    parts[parts.length - 1] += at < 0 ? text : text.slice(0, at);
    if (at >= 0) cut = true;
  };
  tpl.quasis.forEach((q, i) => {
    if (cut) return;
    push(q.value.cooked ?? q.value.raw);
    const e = tpl.expressions[i];
    if (cut || !e) return;
    const known = staticString(e);
    if (known !== undefined) push(known);
    else parts.push('');
  });
  if (!/link|router/i.test(parts.join('')) && !(parts.length > 1 && prefixInSafeDir(parts[0], fromFile))) return false;
  const rx = new RegExp(`^${parts.map(escapeRe).join('.*')}$`, process.platform === 'win32' ? 'is' : 's');
  const from = dirname(fromFile);
  for (const target of SAFE_SOURCES.values()) {
    let rel = relative(from, resolve(ROOT, target)).replace(/\\/g, '/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    const forms = rel.startsWith('../') ? [rel, `./${rel}`] : [rel];
    for (const f of forms) {
      for (const ext of ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']) {
        if (rx.test(f + ext)) return true;
      }
    }
  }
  return false;
}

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
      importExt: 'A26：从 {{src}} 导入 safeHref / hrefOf 要写全 .ts 后缀（架构 2.5；不带扩展名、.js、.mjs、.tsx 等写法时 Vite 可能加载同名的冒牌文件）',
      importDynamic: 'A26：动态 import 的模板串来源带插值、可能指向 shared/logic/link 或 src/app/router，静态核对不了扩展名（架构 2.5）；请写成固定的 “….ts” 字符串',
      badScheme: 'A26：<{{el}}> 的 {{attr}} 常量链接不安全：{{why}}（常量只准相对地址，或 http、https、tel、mailto 且不带用户名和密码，和 safeHref 一致）',
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
      if (staticString(expr) !== undefined) return true;
      if (expr.type === 'CallExpression') return isSafeCallee(expr.callee);
      return false;
    }

    /** 导入、转出口、动态 import 的来源写法（A26-import-ext；模板串见 A26-template） */
    function checkSource(source, typeOnly) {
      if (typeOnly || !source) return;
      const text = staticString(source);
      if (text !== undefined) {
        if (wrongSafeSpelling(text, filename)) context.report({ node: source, messageId: 'importExt', data: { src: text } });
        return;
      }
      if (source.type === 'TemplateLiteral' && templateMayPointToSafe(source, filename)) {
        context.report({ node: source, messageId: 'importDynamic' });
      }
    }

    /** 常量链接的协议（A26-scheme）；value 是常量时查，不是常量不管（由 isSafe 那一路管） */
    function checkScheme(node, el, attr, value) {
      const text = staticString(value);
      if (text === undefined) return;
      const why = badSchemeOf(attr, text);
      if (why !== undefined) context.report({ node, messageId: 'badScheme', data: { el, attr, why } });
    }

    return {
      ImportDeclaration(node) {
        checkSource(node.source, node.importKind === 'type');
      },
      ExportNamedDeclaration(node) {
        checkSource(node.source, node.exportKind === 'type');
      },
      ExportAllDeclaration(node) {
        checkSource(node.source, node.exportKind === 'type');
      },
      ImportExpression(node) {
        checkSource(node.source, false);
      },
      JSXAttribute(node) {
        const attr = attrName(node.name);
        if (!isUrlAttr(attr)) return;
        const el = isNativeElement(node.parent);
        if (!el) return;
        const v = node.value;
        if (!v) return;
        if (v.type === 'Literal') {
          checkScheme(node, el, attr, v);
          return;
        }
        if (v.type === 'JSXExpressionContainer' && isSafe(v.expression)) {
          checkScheme(node, el, attr, v.expression);
          return;
        }
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
          if (p.value && isSafe(p.value)) {
            checkScheme(p, el, key, p.value);
            continue;
          }
          context.report({ node: p, messageId: 'unsafe', data: { el, attr: key } });
        }
      },
    };
  },
};
