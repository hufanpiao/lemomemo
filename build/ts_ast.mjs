// check_binimport.mjs、check_backend_ast.mjs 共用的 TypeScript AST 小工具（11-14 构建与架构检查整块评审：原来两边各写一份 kindOf、遍历）。
// 只放和具体规则无关的几样：按扩展名取 ScriptKind、跳过括号和类型断言、显式栈遍历、字符串表达式的常量折叠、去注释（等长、保留换行）。
import ts from 'typescript';

/** 按扩展名取 ScriptKind（不分大小写）：.tsx → TSX，.ts / .mts / .cts → TS，.jsx → JSX，其余（.js / .mjs / .cjs）→ JS */
export const kindOf = (p) =>
  /\.tsx$/i.test(p) ? ts.ScriptKind.TSX : /\.[cm]?ts$/i.test(p) ? ts.ScriptKind.TS : /\.jsx$/i.test(p) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;

const isWrapper = (n) =>
  ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n);

/** 往里跳过括号、类型断言、非空断言、逗号表达式（取最后一项：(0, require)） */
export function unwrap(n) {
  for (;;) {
    if (isWrapper(n)) n = n.expression;
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.CommaToken) n = n.right;
    else return n;
  }
}

/** 往外跳过括号和类型断言（(x)、x as T、<T>x、x!、x satisfies T），返回最外面那一层 */
export function unwrapUp(n) {
  while (n.parent && isWrapper(n.parent)) n = n.parent;
  return n;
}

/** 直接子节点（forEachChild 的顺序） */
export function children(n) {
  const out = [];
  n.forEachChild((c) => {
    out.push(c);
  });
  return out;
}

/** 显式栈的前序遍历（不递归：深嵌套的代码不会把栈撑爆） */
export function* walk(root) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    yield n;
    const kids = children(n);
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
}

/**
 * 字符串表达式折叠后的值；不是字符串表达式返回 undefined。
 *   '…'、`…` → 原值；`a${x}b` → 插值是能折叠的字符串表达式就代回去（`./t.bi${'n'}` → ./t.bin），否则按空串（只会多报）；
 *   括号、类型断言穿过去；'a' + 'b' 两边都能折叠才折（一边是变量的不折，由调用方分别核对两边的字面量）
 */
export function litText(n) {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => (litText(s.expression) ?? '') + s.literal.text).join('');
  if (isWrapper(n)) return litText(n.expression);
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = litText(n.left);
    const r = l === undefined ? undefined : litText(n.right);
    return r === undefined ? undefined : l + r;
  }
  return undefined;
}

/**
 * 一个文件里引入的模块（tests/arch/coverage.test.ts 用；11-14 整块评审：原来用正则拆 import 子句）：
 * [{ spec, names, star, typeOnly }]。names 是按名字导入的原名（a as b 记 a，单个 type 导入不算）；star：默认导入、* as、export *、import()、require()、
 * import x = require() 这种整体拿到模块的；typeOnly：整条 import type / export type（不会执行）。只认写死的字符串地址
 */
export function importsOf(text, fileName) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kindOf(fileName));
  const out = [];
  const named = (els) => els.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text);
  for (const n of walk(sf)) {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const c = n.importClause;
      const nb = c?.namedBindings;
      out.push({
        spec: n.moduleSpecifier.text,
        names: nb && ts.isNamedImports(nb) ? named(nb.elements) : [],
        star: Boolean(c?.name || (nb && ts.isNamespaceImport(nb))),
        typeOnly: Boolean(c?.isTypeOnly),
      });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const ec = n.exportClause;
      out.push({ spec: n.moduleSpecifier.text, names: ec && ts.isNamedExports(ec) ? named(ec.elements) : [], star: !ec || ts.isNamespaceExport(ec), typeOnly: n.isTypeOnly });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) {
      out.push({ spec: n.moduleReference.expression.text, names: [], star: true, typeOnly: n.isTypeOnly });
    } else if (ts.isCallExpression(n) && n.arguments.length >= 1 && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
      const s = litText(n.arguments[0]);
      if (s !== undefined) out.push({ spec: s, names: [], star: true, typeOnly: false });
    }
  }
  return out;
}

/** 去注释：解析器认出的注释区间换成空格，和原文等长、换行不变（正则、模板字符串、JSX 文本都不会被误当成注释） */
export function stripComments(sf) {
  const text = sf.text;
  const out = text.split('');
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  const stack = [sf];
  while (stack.length) {
    const node = stack.pop();
    const start = node.getStart(sf, false);
    for (const r of ts.getLeadingCommentRanges(text, node.pos) ?? []) if (r.end <= start) blank(r.pos, r.end);
    // 同一行记号后面的注释（x, // 说明）TypeScript 算前一个记号的尾随注释，getLeadingCommentRanges 不给（11-14 A20 改用这份输出时发现漏掉）
    for (const r of ts.getTrailingCommentRanges(text, node.end) ?? []) blank(r.pos, r.end);
    stack.push(...node.getChildren(sf));
  }
  return out.join('');
}
