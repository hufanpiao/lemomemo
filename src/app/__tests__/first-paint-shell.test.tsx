// FIRSTPAINT-nofeature：首屏判断认任何 <main>，所以 App 外壳（页面以外的部分：横幅、提醒、Suspense 占位等）不许有常驻的 <main>，
// 否则页面分包还没到就“画完”了，同步会和页面分包抢下载（root-paint.ts 文件头的约束）
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.tsx';
import { APP_PAGE_SELECTOR } from '../../platform/root-paint.ts';
// 横滑切页在首屏画完以后才懒加载（App.tsx）：慢机器上测试收尾以后才去下，环境已拆掉报 EnvironmentTeardownError（CI 778139cf unit 洛杉矶）；这里不测它，换成空的
vi.mock('../tab-swipe.ts', () => ({ installTabSwipeOnce: () => undefined, installTopLock: () => undefined }));

vi.setConfig({ testTimeout: 15_000 });

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('App 外壳没有常驻的 <main>', () => {
  it('页面分包还没到时一个 main 都没有；页面出来以后只有页面自己那一个', async () => {
    const { container } = render(<App />);
    expect(container.querySelectorAll(APP_PAGE_SELECTOR)).toHaveLength(0);
    const page = await screen.findByRole('main', {}, { timeout: 10_000 });
    expect(page.getAttribute('data-feature')).toBe('today');
    expect(container.querySelectorAll(APP_PAGE_SELECTOR)).toHaveLength(1);
  });
});
