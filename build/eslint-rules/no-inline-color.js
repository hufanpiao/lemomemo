// A11：TSX 的 style 里不准写颜色（#xxx、rgb()、hsl() 等），颜色只在 styles/skins/*.css（架构 2.3）
// 只看 JSX 的 style={{…}} 和传给 style 的对象字面量；用 var(--…) 不算
const COLOR = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|\b(white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|transparent)\b/i;

function stringsIn(node, out) {
  if (!node) return out;
  switch (node.type) {
    case 'Literal':
      if (typeof node.value === 'string') out.push({ node, text: node.value });
      break;
    case 'TemplateLiteral':
      out.push({ node, text: node.quasis.map((q) => q.value.cooked ?? '').join(' ') });
      break;
    case 'ObjectExpression':
      for (const p of node.properties) if (p.type === 'Property') stringsIn(p.value, out);
      break;
    case 'ConditionalExpression':
      stringsIn(node.consequent, out);
      stringsIn(node.alternate, out);
      break;
    case 'LogicalExpression':
      stringsIn(node.left, out);
      stringsIn(node.right, out);
      break;
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
      stringsIn(node.expression, out);
      break;
    default:
      break;
  }
  return out;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'A11：TSX 的 style 里不准写颜色' },
    schema: [],
    messages: { color: 'A11：style 里不准写颜色（{{text}}），用 var(--…)，颜色只在 styles/skins/*.css' },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'style') return;
        if (!node.value || node.value.type !== 'JSXExpressionContainer') return;
        for (const s of stringsIn(node.value.expression, [])) {
          const text = s.text.replace(/var\([^)]*\)/g, '');
          if (COLOR.test(text)) context.report({ node: s.node, messageId: 'color', data: { text: s.text.slice(0, 40) } });
        }
      },
    };
  },
};
