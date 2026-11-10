// A31：settings 的写法（架构 2.3、0.41 第 2 条；接手清单 CONSENT-sugg ⑤）
// 拦 write.insert / write.patch 的第一个参数是 'settings' 的调用（write.x、write['x'] 都认）：
//   ① 参数里的对象字面量（含嵌套、展开的对象字面量）写了 deleted_at 或 undone 键 → 报：功能代码不对 settings 发软删、撤销
//      （ai.enabled、ai.vault 删掉一行在 aiAllowed 里等于回到默认值；别的键要删，先在架构 0.41 登记再给这条规则开口）
//   ② 参数里出现字符串 'ai.enabled' / 'ai.vault' → 报：这两个键只经 core/ai-settings.ts 的 writeAiSwitch 写
//   ③ writeAiSwitch / writeAiSwitchSettled 写 ai.enabled 时，value 不是字面量 false → 只准在 src/features/onboarding/ 下（告知页本人勾选同意后），
//      别处只能写 false（关掉）；参数不是对象字面量、看不出键和值的也报（B3 FA-4 安全审第 4 条：防以后有人在设置里绕过告知页直接打开）。
//      按 import 来源认（改名导入、命名空间 ns['x'] 都算），改名导入的函数当值用也报；ai.vault 同样要字面量 false（安全审复核建议 1、2）
// 例外（eslint.config.js 里关掉）：core/ai-settings.ts（唯一写法，恢复时要写 deleted_at: null）、core/write.ts（守门本身）、测试。
// 恢复的 patch 内容只由 core/setting-patch.ts 的 settingPatch 给（ai-settings 和 calendar 的 cal-settings 共用，B2 安全审查 FA3-2），别处不要自己拼
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

const SWITCH_FNS = new Set(['writeAiSwitch', 'writeAiSwitchSettled']);

/** 属性名（x.y、x['y']） */
function propName(m) {
  return m.computed ? strOf(m.property) : m.property.type === 'Identifier' ? m.property.name : undefined;
}

/**
 * 是不是 writeAiSwitch / writeAiSwitchSettled 的调用（安全审复核建议 1：按 import 来源认，改名导入也算）：
 * 本文件 import 进来的本地名（含 `as` 改名）、命名空间导入的 ns.x / ns['x']；另外照旧认这两个函数名本身和 x.writeAiSwitch
 */
function isSwitchCall(callee, local, ns) {
  if (callee.type === 'Identifier') return local.has(callee.name) || SWITCH_FNS.has(callee.name);
  if (callee.type !== 'MemberExpression') return false;
  const name = propName(callee);
  if (name === undefined || !SWITCH_FNS.has(name)) return false;
  return !callee.computed || (callee.object.type === 'Identifier' && ns.has(callee.object.name));
}

/** 第一个参数是对象字面量时取出 key（字符串）和 value 节点；不是对象字面量、带展开等看不出来的返回 null */
function switchArg(arg) {
  let a = arg;
  while (a && (a.type === 'TSAsExpression' || a.type === 'TSSatisfiesExpression' || a.type === 'TSNonNullExpression')) a = a.expression;
  if (!a || a.type !== 'ObjectExpression') return null;
  let key;
  let value;
  for (const p of a.properties) {
    if (p.type !== 'Property') return null;
    const k = keyOf(p);
    if (k === 'key') key = strOf(p.value);
    else if (k === 'value') value = p.value;
  }
  return { key, off: value?.type === 'Literal' && value.value === false };
}

/** key 是 ai.enabled 或 ai.vault，value 是字面量 false（关掉） */
function writesOff(arg) {
  const a = switchArg(arg);
  return a !== null && (a.key === 'ai.enabled' || a.key === 'ai.vault') && a.off;
}

/** 写 ai.vault 且 value 不是字面量 false（安全审复核建议 2：ai.vault 打开只能经服务器 set_ai_vault，哪里都不准写别的值，onboarding 也不例外） */
function vaultNotOff(arg) {
  const a = switchArg(arg);
  return a !== null && a.key === 'ai.vault' && !a.off;
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
      aiOn: 'A31：只有 src/features/onboarding/ 下（告知页本人勾选同意后）能把 ai.enabled 写成 true；别处只能写字面量 false；ai.vault 哪里都只能写字面量 false（架构 15.5 第三轮 X5、0.29 续第 146 条）',
    },
  },
  create(context) {
    const file = (context.filename ?? context.getFilename()).split('\\').join('/');
    const inOnboarding = file.includes('/src/features/onboarding/');
    /** 从 core/ai-settings 导入的这两个函数的本地名（含改名），和命名空间导入的名字 */
    const local = new Set();
    const ns = new Set();
    return {
      ImportDeclaration(node) {
        if (typeof node.source.value !== 'string' || !/(^|\/)ai-settings(\.ts)?$/.test(node.source.value)) return;
        for (const sp of node.specifiers) {
          if (sp.type === 'ImportSpecifier' && SWITCH_FNS.has(sp.imported.name ?? sp.imported.value)) local.add(sp.local.name);
          else if (sp.type === 'ImportNamespaceSpecifier') ns.add(sp.local.name);
        }
      },
      // 改名导入的函数不准当值传来传去（const f = w、(0, w)(…)、w.call(…)）：静态规则看不出它写什么，onboarding 以外一律报
      Identifier(node) {
        if (inOnboarding || !local.has(node.name)) return;
        const p = node.parent;
        if (p.type === 'ImportSpecifier' || (p.type === 'CallExpression' && p.callee === node)) return;
        context.report({ node, messageId: 'aiOn' });
      },
      CallExpression(node) {
        if (isSwitchCall(node.callee, local, ns) && (inOnboarding ? vaultNotOff(node.arguments[0]) : !writesOff(node.arguments[0]))) {
          context.report({ node, messageId: 'aiOn' });
          return;
        }
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
