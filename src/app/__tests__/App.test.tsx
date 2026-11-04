// App 外壳（架构 2.0、2.1）：按 hash 挂懒加载的页面；页面出错只坏这一页，显示错误状态
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.tsx';

// 整个 App 挂载、页面懒加载：全量三个时区同时跑、机器忙时会拖过默认 5 秒（c8b5596 的 CI unit 就是这样超时的），
// 这个文件单独放宽到 15 秒，等页面出现的上限 10 秒；单跑仍在 3 秒内
vi.setConfig({ testTimeout: 15_000 });

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('App', () => {
  it('默认进今天页（懒加载）', async () => {
    render(<App />);
    // 懒加载在全量并发下可能超过默认的 1 秒（11-03 快照 r84 偶发失败），放宽到 5 秒
    const page = await screen.findByRole('main', {}, { timeout: 10_000 });
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
