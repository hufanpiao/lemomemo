// A26：JSX 里原生元素的 href、src 等只能是字符串常量、路由函数 hrefOf() 或 safeHref() 的返回值（架构 2.3，第二轮安全 N9）
// 只管小写开头的原生元素（<a>、<img>、<iframe>…）；自己的组件在组件内部落到原生元素时再检查
const URL_ATTRS = new Set(['href', 'src', 'srcSet', 'action', 'formAction', 'poster', 'data', 'xlinkHref']);
const SAFE_CALLS = new Set(['safeHref', 'hrefOf']);

function attrName(n) {
  if (n.type === 'JSXIdentifier') return n.name;
  if (n.type === 'JSXNamespacedName') return `${n.namespace.name}${n.name.name[0].toUpperCase()}${n.name.name.slice(1)}`;
  return '';
}

function isSafe(expr) {
  if (expr.type === 'Literal' && typeof expr.value === 'string') return true;
  if (expr.type === 'TemplateLiteral' && expr.expressions.length === 0) return true;
  if (expr.type === 'CallExpression') {
    const c = expr.callee;
    if (c.type === 'Identifier') return SAFE_CALLS.has(c.name);
    if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier') return SAFE_CALLS.has(c.property.name);
  }
  return false;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'A26：href、src 只能是常量、hrefOf() 或 safeHref()' },
    schema: [],
    messages: { unsafe: 'A26：<{{el}}> 的 {{attr}} 只能是字符串常量、hrefOf() 或 safeHref() 的返回值' },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        const attr = attrName(node.name);
        if (!URL_ATTRS.has(attr)) return;
        const el = node.parent.name;
        if (el.type !== 'JSXIdentifier' || !/^[a-z]/.test(el.name)) return;
        const v = node.value;
        if (!v || v.type === 'Literal') return;
        if (v.type === 'JSXExpressionContainer' && isSafe(v.expression)) return;
        context.report({ node, messageId: 'unsafe', data: { el: el.name, attr } });
      },
    };
  },
};
