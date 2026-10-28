// 动效令牌两边一致（架构 17.2 第 1 点、1.3 B0 验收）：src/motion/tokens.ts 和 src/styles/tokens.css 是同一组值
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cssVarOf, dur, ease, spring, SPRING_DAMPING_RATIO, SPRING_MASS, SPRING_STIFFNESS, tr } from '../tokens.ts';

const css = readFileSync(join(import.meta.dirname, '..', '..', 'styles', 'tokens.css'), 'utf8');
// 只看第一个 :root{…}（减少动态效果那两段会把 --dur-press 改成 0）
const rootBlock = /:root\{([^}]*)\}/.exec(css)?.[1] ?? '';
const vars = new Map(
  rootBlock
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.startsWith('--'))
    .map((d) => {
      const i = d.indexOf(':');
      return [d.slice(0, i).trim(), d.slice(i + 1).trim()] as const;
    }),
);

function seconds(v: string): number {
  const m = /^(-?\d*\.?\d+)(ms|s)$/.exec(v);
  if (!m?.[1]) throw new Error(`不是时长：${v}`);
  return m[2] === 'ms' ? Number(m[1]) / 1000 : Number(m[1]);
}

function bezier(v: string): number[] {
  const m = /^cubic-bezier\(([^)]*)\)$/.exec(v);
  if (!m?.[1]) throw new Error(`不是 cubic-bezier：${v}`);
  return m[1].split(',').map((x) => Number(x.trim()));
}

describe('动效令牌：TS 和 CSS 一致', () => {
  for (const [k, name] of Object.entries(cssVarOf.dur) as [keyof typeof dur, string][]) {
    it(`dur.${k} = ${name}`, () => {
      const v = vars.get(name);
      expect(v, `tokens.css 里没有 ${name}`).toBeDefined();
      expect(seconds(v ?? '')).toBeCloseTo(dur[k], 6);
    });
  }

  for (const [k, name] of Object.entries(cssVarOf.ease) as [keyof typeof ease, string][]) {
    it(`ease.${k} = ${name}`, () => {
      const v = vars.get(name);
      expect(v, `tokens.css 里没有 ${name}`).toBeDefined();
      expect(bezier(v ?? '')).toEqual([...ease[k]]);
    });
  }

  it('CSS 里每个 --dur-*、--ease-* 在 TS 里都有对应', () => {
    const mapped = new Set<string>([...Object.values(cssVarOf.dur), ...Object.values(cssVarOf.ease)]);
    const inCss = [...vars.keys()].filter((k) => k.startsWith('--dur-') || k.startsWith('--ease-'));
    expect(inCss.filter((k) => !mapped.has(k))).toEqual([]);
  });

  it('减少动态效果时按下回弹时长为 0（系统设置和设置里的开关两条）', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\{:root\{--dur-press:0ms\}\}/);
    expect(css).toMatch(/:root\[data-rm="1"\]\{--dur-press:0ms\}/);
  });

  it('弹簧：刚度 380、阻尼比 0.78、质量 1，damping = 2·ζ·√(k·m)（17.2）', () => {
    expect([SPRING_STIFFNESS, SPRING_DAMPING_RATIO, SPRING_MASS]).toEqual([380, 0.78, 1]);
    expect(spring.damping).toBeCloseTo(2 * 0.78 * Math.sqrt(380), 9);
    expect(spring.damping / (2 * Math.sqrt(spring.stiffness * spring.mass))).toBeGreaterThanOrEqual(0.72);
  });

  it('现成的 transition 只引用令牌', () => {
    expect(tr.ui).toEqual({ duration: dur.ui, ease: ease.out });
    expect(tr.sheet).toEqual({ duration: dur.sheet, ease: ease.drawer });
  });
});
