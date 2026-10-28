// A24：TS / TSX 里的动效时长和曲线只能用 src/motion/tokens.ts 的常量（架构 2.3、17.3）
// 拦：duration/delay 写数字、ease/easing 写数组或字符串、弹簧参数写数字、
//     style 里 transition/animation 写死时长或 cubic-bezier
// src/motion/tokens.ts 本身在 eslint.config.js 里豁免
const TIME_KEYS = new Set(['duration', 'delay', 'repeatDelay']);
const EASE_KEYS = new Set(['ease', 'easing']);
const SPRING_KEYS = new Set(['stiffness', 'damping', 'mass', 'bounce', 'visualDuration']);
const CSS_KEYS = new Set([
  'transition',
  'animation',
  'transitionDuration',
  'animationDuration',
  'transitionTimingFunction',
  'animationTimingFunction',
  'transitionDelay',
  'animationDelay',
]);
const HARD_CSS = /(\d*\.?\d+m?s\b)|cubic-bezier\(|steps\(|\b(ease|ease-in|ease-out|ease-in-out|linear)\b/;

function keyName(p) {
  if (p.computed) return null;
  if (p.key.type === 'Identifier') return p.key.name;
  if (p.key.type === 'Literal') return String(p.key.value);
  return null;
}

function isNumber(n) {
  return (
    (n.type === 'Literal' && typeof n.value === 'number') ||
    (n.type === 'UnaryExpression' && n.argument.type === 'Literal' && typeof n.argument.value === 'number')
  );
}

function stringOf(n) {
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral') return n.quasis.map((q) => q.value.cooked ?? '').join(' ');
  return null;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'A24：动效时长和曲线只能用 motion/tokens.ts 的常量' },
    schema: [],
    messages: {
      time: 'A24：{{key}} 不准写数字，用 src/motion/tokens.ts 的 dur.*',
      ease: 'A24：{{key}} 不准写数组或字符串，用 src/motion/tokens.ts 的 ease.*',
      spring: 'A24：弹簧参数 {{key}} 不准写数字，用 src/motion/tokens.ts 的 spring',
      css: 'A24：style 里的 {{key}} 不准写死时长或曲线，用 var(--dur-*)、var(--ease-*)',
    },
  },
  create(context) {
    return {
      Property(node) {
        const key = keyName(node);
        if (!key) return;
        const v = node.value;
        if (TIME_KEYS.has(key) && isNumber(v)) {
          context.report({ node, messageId: 'time', data: { key } });
        } else if (EASE_KEYS.has(key) && (v.type === 'ArrayExpression' || stringOf(v) !== null)) {
          context.report({ node, messageId: 'ease', data: { key } });
        } else if (SPRING_KEYS.has(key) && isNumber(v)) {
          context.report({ node, messageId: 'spring', data: { key } });
        } else if (CSS_KEYS.has(key)) {
          const s = stringOf(v);
          if (s !== null && HARD_CSS.test(s.replace(/var\([^)]*\)/g, ''))) {
            context.report({ node, messageId: 'css', data: { key } });
          }
        }
      },
    };
  },
};
