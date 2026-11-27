// 浮条离底（--dock-bottom）在手机 / 宽屏 × 键盘弹没弹四种状态下算出来是多少（台账 Q-20）：jsdom 不算媒体查询和层叠，
// 这里按 base.css 源码自己排：只认 :root、:root[data-kbo] 两种选择器和 (width >= 900px)、(width < 900px) 两种媒体条件，
// 优先级高的赢、一样高的后写的赢；再把 var()、calc()、max() 按给定的安全区、键盘高度、--vh-gap 算成像素
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync('src/styles/base.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

interface State {
  readonly wide: boolean;
  readonly kbo: boolean;
}

/** 这个状态下 :root 上最后生效的 name 的写法；没有是 null */
function declared(name: string, s: State): string | null {
  let best: { spec: number; value: string } | null = null;
  const media = (cond: string): boolean => (cond === '(width >= 900px)' ? s.wide : cond === '(width < 900px)' ? !s.wide : false);
  const walk = (src: string, on: boolean): void => {
    let i = 0;
    for (;;) {
      const open = src.indexOf('{', i);
      if (open < 0) return;
      let depth = 1;
      let j = open + 1;
      for (; depth > 0 && j < src.length; j++) depth += src[j] === '{' ? 1 : src[j] === '}' ? -1 : 0;
      const head = src.slice(i, open).trim();
      const body = src.slice(open + 1, j - 1);
      if (head.startsWith('@media')) walk(body, on && media(head.slice('@media'.length).trim()));
      else if (on && !head.startsWith('@')) {
        const spec = Math.max(...head.split(',').map((sel) => (sel.trim() === ':root' ? 1 : sel.trim() === ':root[data-kbo]' && s.kbo ? 2 : 0)));
        const m = spec > 0 ? body.match(new RegExp(`(?:^|[;\\s])${name}:\\s*([^;]+);`)) : null;
        if (m?.[1] && (best === null || spec >= best.spec)) best = { spec, value: m[1].trim() };
      }
      i = j;
    }
  };
  walk(CSS, true);
  return best === null ? null : (best as { value: string }).value;
}

/** 把写法算成像素：var() 先看 given、再看 base.css、再用后备值；只有 calc 的加减和 max */
function px(expr: string, s: State, given: Record<string, number>): number {
  let at = 0;
  const ws = (): void => {
    while (expr[at] === ' ') at += 1;
  };
  const value = (): number => {
    ws();
    const fn = /^(var|calc|max)\(/.exec(expr.slice(at));
    if (fn?.[1]) {
      at += fn[0].length;
      const out = fn[1] === 'var' ? variable() : fn[1] === 'calc' ? sum() : Math.max(...list());
      ws();
      at += 1; // ')'
      return out;
    }
    const num = /^-?\d+(\.\d+)?px/.exec(expr.slice(at));
    if (!num) throw new Error(`看不懂：${expr.slice(at)}`);
    at += num[0].length;
    return Number.parseFloat(num[0]);
  };
  const sum = (): number => {
    let out = value();
    for (ws(); expr[at] === '+' || expr[at] === '-'; ws()) {
      const sign = expr[at] === '+' ? 1 : -1;
      at += 1;
      out += sign * value();
    }
    return out;
  };
  const list = (): number[] => {
    const out = [sum()];
    for (ws(); expr[at] === ','; ws()) {
      at += 1;
      out.push(sum());
    }
    return out;
  };
  const variable = (): number => {
    const name = /^--[\w-]+/.exec(expr.slice(at))?.[0] ?? '';
    at += name.length;
    ws();
    let fallback: number | null = null;
    if (expr[at] === ',') {
      at += 1;
      fallback = sum();
    }
    if (name in given) return given[name] ?? 0;
    const own = declared(name, s);
    if (own !== null) return px(own, s, given);
    if (fallback === null) throw new Error(`${name} 没定义也没后备值`);
    return fallback;
  };
  return sum();
}

const dock = (s: State, given: Record<string, number>): number => px(declared('--dock-bottom', s) ?? '', s, { '--inset-bottom': 34, ...given });

describe('--dock-bottom 四种状态（台账 Q-20）', () => {
  it('手机、键盘没弹：底栏上方 安全区 + 118；--vh-gap 补到屏幕底', () => {
    expect(dock({ wide: false, kbo: false }, {})).toBe(34 + 118);
    expect(dock({ wide: false, kbo: false }, { '--vh-gap': 61 })).toBe(34 + 118 - 61);
  });

  it('手机、键盘弹着：贴键盘上沿（主屏幕版 --kb 不写是 0，浏览器里是键盘高）', () => {
    expect(dock({ wide: false, kbo: true }, {})).toBe(0);
    expect(dock({ wide: false, kbo: true }, { '--kb': 320 })).toBe(320);
  });

  it('宽屏、键盘没弹：安全区 + 24；不减 --vh-gap（宽屏没有底栏，iPhone 大屏横屏主屏幕版 --vh-gap=61 也不往下挪，和改前一样）', () => {
    expect(dock({ wide: true, kbo: false }, {})).toBe(34 + 24);
    expect(dock({ wide: true, kbo: false }, { '--vh-gap': 61 })).toBe(34 + 24);
    expect(dock({ wide: true, kbo: false }, { '--kb': 320 })).toBe(320);
  });

  it('Q-20 宽屏、键盘弹着：照旧安全区 + 24 和键盘高取大的（不被手机那条键盘规则盖成 0）', () => {
    expect(dock({ wide: true, kbo: true }, {})).toBe(34 + 24);
    expect(dock({ wide: true, kbo: true }, { '--kb': 320 })).toBe(320);
  });
});
