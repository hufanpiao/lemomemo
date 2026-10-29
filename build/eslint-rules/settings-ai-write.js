// A31：settings 的写法（架构 2.3、0.41 第 2 条；接手清单 CONSENT-sugg ⑤）
// 拦 write.insert / write.patch 的第一个参数是 'settings' 的调用（write.x、write['x'] 都认）：
//   ① 参数里的对象字面量（含嵌套、展开的对象字面量）写了 deleted_at 或 undone 键 → 报：功能代码不对 settings 发软删、撤销
//      （ai.enabled、ai.vault 删掉一行在 aiAllowed 里等于回到默认值；别的键要删，先在架构 0.41 登记再给这条规则开口）
//   ② 参数里出现字符串 'ai.enabled' / 'ai.vault' → 报：这两个键只经 core/ai-settings.ts 的 writeAiSwitch 写
// 例外（eslint.config.js 里关掉）：core/ai-settings.ts（唯一写法，恢复时要写 deleted_at: null）、core/write.ts（守门本身）、测试。
// 静态规则管不到的：数据先放进变量再传（write.patch('settings', id, data)）、表名是变量——运行时还有 write.* 的 guardSettings
// 和服务器的 settings_guard 两道（0.41 第 1、2 条）
const AI_KEYS = new Set(['ai.enabled', 'ai.vault']);
const REMOVE_KEYS = new Set(['deleted_at', 'undone']);

function strOf(node) {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return undefined;
}

function keyOf(p) {
  if (!p.computed && p.key.type === 'Identifier') return p.key.name;
  return strOf(p.key);
}

/** 是不是 write.insert / write.patch（含 write['insert']） */
function isWriteCall(callee) {
  if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier' || callee.object.name !== 'write') return false;
  const name = callee.computed ? strOf(callee.property) : callee.property.type === 'Identifier' ? callee.property.name : undefined;
  return name === 'insert' || name === 'patch';
}

/** 走一遍参数（只走字面量的结构：对象、数组、展开、as、括号） */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  switch (node.type) {
    case 'ObjectExpression':
      for (const p of node.properties) {
        if (p.type === 'Property') {
          visit(p);
          walk(p.key, visit);
          walk(p.value, visit);
        } else walk(p.argument, visit);
      }
      break;
    case 'ArrayExpression':
      for (const e of node.elements) walk(e, visit);
      break;
    case 'SpreadElement':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
      walk(node.argument ?? node.expression, visit);
      break;
    case 'ConditionalExpression':
      walk(node.consequent, visit);
      walk(node.alternate, visit);
      break;
    case 'LogicalExpression':
      walk(node.left, visit);
      walk(node.right, visit);
      break;
    default:
      break;
  }
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'A31：功能代码不对 settings 写 deleted_at / undone；ai.enabled、ai.vault 只经 writeAiSwitch 写' },
    schema: [],
    messages: {
      remove: 'A31：不准对 settings 写 {{key}}（不发软删、撤销；ai.enabled、ai.vault 只能改值，架构 0.41 第 2 条）',
      aiKey: 'A31：{{key}} 只能经 core/ai-settings.ts 的 writeAiSwitch 写（不准直接 write.insert / write.patch）',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isWriteCall(node.callee) || strOf(node.arguments[0]) !== 'settings') return;
        for (const arg of node.arguments.slice(1)) {
          walk(arg, (n) => {
            if (n.type === 'Property') {
              const k = keyOf(n);
              if (k !== undefined && REMOVE_KEYS.has(k)) context.report({ node: n, messageId: 'remove', data: { key: k } });
            }
            const s = strOf(n);
            if (s !== undefined && AI_KEYS.has(s)) context.report({ node: n, messageId: 'aiKey', data: { key: s } });
          });
        }
      },
    };
  },
};
