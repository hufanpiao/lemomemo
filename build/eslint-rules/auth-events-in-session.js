// A30：本页的登录事件只在会话层接（架构 2.3、4.1；接手清单 K6-signedout、K6-signedout-sugg ③）
// 全仓（src、shared、官网 site 的脚本，.ts / .tsx / .js / .mjs）只有 src/platform/session.ts 能：
//   ① 订阅 onAuthStateChange（x.onAuthStateChange、x['onAuthStateChange']、解构 { onAuthStateChange }）
//   ② 写出事件名 'SIGNED_OUT'（字符串、无插值的模板字符串）
// K8、各功能页不各自监听 SIGNED_OUT：被移除、被退出由 session.ts 的 onAuthUser → core/account.ts 的 watchAccount 统一处理，
// 自己退出的那一次按“自己退出”的标记滤掉。原来是 session-signedout.test.ts 里扫文件的守卫测试（只扫 src 的 ts/tsx），改成 lint 并扩到 shared、site 和 .js
// 不管测试（__tests__、tests/）：测试要模拟这些事件。哪些文件开、哪个文件例外见 eslint.config.js
const MSG = 'A30：只有 src/platform/session.ts 能订阅 onAuthStateChange、认 SIGNED_OUT（K6-signedout；别处经 onAuthUser 拿回调）';

function propName(node) {
  if (!node) return undefined;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return undefined;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'A30：onAuthStateChange、SIGNED_OUT 只准出现在 src/platform/session.ts' },
    schema: [],
    messages: { only: MSG },
  },
  create(context) {
    const report = (node) => context.report({ node, messageId: 'only' });
    return {
      MemberExpression(node) {
        const name = node.computed ? propName(node.property) : node.property.type === 'Identifier' ? node.property.name : undefined;
        if (name === 'onAuthStateChange') report(node);
      },
      Property(node) {
        // 解构 const { onAuthStateChange } = db.auth
        if (node.parent?.type === 'ObjectPattern' && propName(node.key) === 'onAuthStateChange') report(node);
      },
      Literal(node) {
        if (node.value === 'SIGNED_OUT') report(node);
      },
      TemplateLiteral(node) {
        if (node.expressions.length === 0 && node.quasis[0].value.cooked === 'SIGNED_OUT') report(node);
      },
    };
  },
};
