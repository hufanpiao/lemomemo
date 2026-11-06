// MeAvatar：本人头像圈（今天页右上角、设置首页账号一行共用，负责人 11-05）
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeAvatar } from '../MeAvatar.tsx';

const me = vi.hoisted(() => ({ initial: null as string | null }));
vi.mock('../../hooks/useMeInitial.ts', () => ({ useMeInitial: () => me.initial }));

afterEach(() => {
  me.initial = null;
  cleanup();
});

describe('MeAvatar', () => {
  it('有名字：写第一个字，不画人形', () => {
    me.initial = '김';
    render(<MeAvatar testId="av" />);
    const av = screen.getByTestId('av');
    expect(av.textContent).toBe('김');
    expect(av.querySelector('svg')).toBeNull();
  });

  it('没有名字：画人形；整个头像只是装饰，读屏不念', () => {
    render(<MeAvatar testId="av" />);
    const av = screen.getByTestId('av');
    expect(av.textContent).toBe('');
    expect(av.querySelector('svg path')).not.toBeNull();
    expect(av.getAttribute('aria-hidden')).toBe('true');
  });
});
