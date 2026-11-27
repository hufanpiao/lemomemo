// A26-spread（接手清单）：Pressable 把 rest 展开到 <button>，类型挡不住绕过写法；运行时要去掉链接类键（大小写不敏感）
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Pressable } from '../Pressable.tsx';

describe('Pressable 不把链接类属性带到 <button> 上', () => {
  afterEach(cleanup);

  const cases: Record<string, string>[] = [
    { formaction: 'javascript:x' },
    { formAction: 'javascript:x' },
    { FORMACTION: 'javascript:x' },
    { href: 'javascript:x' },
    { 'xlink:href': 'javascript:x' },
  ];
  for (const extra of cases) {
    it(`传 ${JSON.stringify(extra)} → button 上没有这个属性`, () => {
      // 故意绕过类型（as object）模拟调用方的绕过写法
      const p = extra as object;
      render(<Pressable {...p}>ok</Pressable>);
      const btn = screen.getByRole('button');
      for (const k of Object.keys(extra)) expect(btn.hasAttribute(k), k).toBe(false);
      expect(btn.hasAttribute('formaction')).toBe(false);
      for (const a of Array.from(btn.attributes)) expect(a.value, a.name).not.toContain('javascript:');
    });
  }

  it('普通属性照常透传', () => {
    render(
      <Pressable aria-label="ok-label" data-testid="p" disabled>
        ok
      </Pressable>,
    );
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-label')).toBe('ok-label');
    expect(btn.dataset['testid']).toBe('p');
    expect(btn.hasAttribute('disabled')).toBe(true);
  });
});
