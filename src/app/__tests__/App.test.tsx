// App 外壳（架构 2.0、2.1）：按 hash 挂懒加载的页面；页面出错只坏这一页，显示错误状态
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../App.tsx';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('App', () => {
  it('默认进今天页（懒加载）', async () => {
    render(<App />);
    const page = await screen.findByRole('main');
    expect(page.getAttribute('data-feature')).toBe('today');
  });

  it('换 hash 就换页面', async () => {
    render(<App />);
    await screen.findByRole('main');
    await act(async () => {
      window.location.hash = '#/notes';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    const page = await screen.findByRole('main');
    expect(page.getAttribute('data-feature')).toBe('notes');
  });
});
