// A23：supabase/functions/ 里不准把请求头、请求体打进日志（架构 2.3、8.4）
// 拦 console.* 的参数里出现：req / request 本身、任何 .headers / .body、
// 读请求体的 .json() .text() .formData() .arrayBuffer() .blob()
// vault、ai-voice 两个函数一律不准 console.*，那条用 eslint.config.js 里的 no-console 管
const REQ_NAMES = new Set(['req', 'request', 'headers', 'body']);
const BODY_READERS = new Set(['json', 'text', 'formData', 'arrayBuffer', 'blob']);

function touchesRequest(node) {
  if (!node || typeof node !== 'object') return false;
  switch (node.type) {
    case 'Identifier':
      return REQ_NAMES.has(node.name);
    case 'MemberExpression':
      if (!node.computed && node.property.type === 'Identifier' && (node.property.name === 'headers' || node.property.name === 'body')) {
        return true;
      }
      return touchesRequest(node.object);
    case 'CallExpression':
      if (
        node.callee.type === 'MemberExpression' &&
        !node.callee.computed &&
        node.callee.property.type === 'Identifier' &&
        BODY_READERS.has(node.callee.property.name)
      ) {
        return true;
      }
      return touchesRequest(node.callee) || node.arguments.some(touchesRequest);
    case 'AwaitExpression':
    case 'SpreadElement':
    case 'TSAsExpression':
    case 'TSNonNullExpression':
      return touchesRequest(node.argument ?? node.expression);
    case 'TemplateLiteral':
      return node.expressions.some(touchesRequest);
    case 'BinaryExpression':
    case 'LogicalExpression':
      return touchesRequest(node.left) || touchesRequest(node.right);
    case 'ObjectExpression':
      return node.properties.some((p) => (p.type === 'Property' ? touchesRequest(p.value) : touchesRequest(p)));
    case 'ArrayExpression':
      return node.elements.some(touchesRequest);
    case 'ConditionalExpression':
      return touchesRequest(node.consequent) || touchesRequest(node.alternate);
    default:
      return false;
  }
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'A23：服务器函数不准打印请求头、请求体' },
    schema: [],
    messages: { leak: 'A23：不准把请求头、请求体或 req 本身打进日志' },
  },
  create(context) {
    return {
      CallExpression(node) {
        const c = node.callee;
        if (c.type !== 'MemberExpression' || c.object.type !== 'Identifier' || c.object.name !== 'console') return;
        if (node.arguments.some(touchesRequest)) context.report({ node, messageId: 'leak' });
      },
    };
  },
};
