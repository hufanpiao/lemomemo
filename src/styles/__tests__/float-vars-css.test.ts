// 浮层位置变量接线防回退（台账 Q-8、Q-13，R-395、R-396；独立验证 11-11 建议 7）：jsdom 不算布局，按源码文字核对。
// 键盘没弹时 --dock-bottom 减 --dock-gap（手机 = --vh-gap，底栏和贴底浮层一起焊死；宽屏取值见 dock-bottom-cascade.test.ts）；键盘弹着时只等于 --kb（光标试验的补抬 11-11 已删）；
// 随手记输入行和提示条键盘没弹时都减 --inrow-drop，提示条才不会和输入行脱开
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const base = readFileSync('src/styles/base.css', 'utf8');
const notes = readFileSync('src/features/notes/ui/NotesPage.module.css', 'utf8');

function block(src: string, selector: string): string {
  const at = src.indexOf(`${selector} {`);
  if (at < 0) return '';
  return src.slice(at, src.indexOf('}', at));
}

const prop = (b: string, name: string): string => (b.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1] ?? '').trim();

describe('浮层位置变量接线', () => {
  it(':root 的 --dock-bottom 减 --dock-gap，--dock-gap 就是 --vh-gap', () => {
    const root = block(base, ':root');
    expect(prop(root, '--dock-bottom')).toMatch(/-\s*var\(--dock-gap\)/);
    expect(prop(root, '--dock-gap')).toBe('var(--vh-gap, 0px)');
  });

  it('键盘弹着（data-kbo）的 --dock-bottom 就是 --kb，且 --inrow-drop 归零', () => {
    const kbo = block(base, ':root[data-kbo]');
    expect(prop(kbo, '--dock-bottom')).toBe('var(--kb, 0px)');
    expect(prop(kbo, '--inrow-drop')).toBe('0px');
  });

  it('随手记输入行和提示条都减 --inrow-drop', () => {
    expect(prop(block(notes, '.inrow'), 'bottom')).toMatch(/-\s*var\(--inrow-drop,\s*0px\)/);
    expect(prop(block(notes, '.error,\n.tip'), 'bottom')).toMatch(/-\s*var\(--inrow-drop,\s*0px\)/);
  });
});
