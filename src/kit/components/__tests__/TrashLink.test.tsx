// TrashLink：“最近删除”入口（审查 11-15 第 2 条，随手记、隐私记、待办、设置共用）：是 <a href> 链接，普通点按交给路由，带修饰键的交给浏览器（新标签页）
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock('../../../app/router.ts', async (orig) => ({
  ...(await orig<object>()),
  navigate: (...a: string[]) => (nav.calls.push(a), Promise.resolve()),
}));

const { TrashLink } = await import('../TrashLink.tsx');

afterEach(cleanup);
beforeEach(() => {
  nav.calls = [];
});

describe('TrashLink', () => {
  it('胶囊：外面一层居中的 div，里面是 <a href>（地址经 hrefOf）；文案照调用方给的', () => {
    render(<TrashLink to={['vault', 'trash']} label="最近删除 2" testId="t" />);
    const a = screen.getByTestId('t');
    expect(a.tagName).toBe('A');
    expect(a.getAttribute('href')).toBe('#/vault/trash');
    expect(a.textContent).toBe('最近删除 2');
    expect(a.className).toMatch(/pill/);
    expect(a.parentElement?.tagName).toBe('DIV');
  });

  it('inline：句子里的一个链接，不另包一层', () => {
    const { container } = render(
      <p>
        空间满了
        <TrashLink look="inline" to={['trash']} label="最近删除" testId="t" />
      </p>,
    );
    const a = screen.getByTestId('t');
    expect(a.className).toMatch(/inline/);
    expect(a.parentElement).toBe(container.querySelector('p'));
  });

  it('icon（R-438）：顶栏里的图标链接，不另包一层、不显示字；label 当读屏名称和悬停提示，图标对读屏隐藏', () => {
    render(<TrashLink look="icon" to={['trash']} label="最近删除 3" testId="t" />);
    const a = screen.getByTestId('t');
    expect(a.tagName).toBe('A');
    expect(a.getAttribute('href')).toBe('#/trash');
    expect(a.className).toMatch(/icon/);
    expect(a.textContent).toBe('');
    expect(a.getAttribute('aria-label')).toBe('最近删除 3');
    expect(a.getAttribute('title')).toBe('最近删除 3');
    expect(a.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(a, { button: 0 });
    expect(nav.calls).toEqual([['trash']]);
  });

  it('普通点按交给路由（navigate 同一组参数）；Ctrl 点不拦，交给浏览器开新标签页', () => {
    render(<TrashLink to={['vault', 'trash']} label="最近删除" testId="t" />);
    fireEvent.click(screen.getByTestId('t'), { button: 0 });
    expect(nav.calls).toEqual([['vault', 'trash']]);
    fireEvent.click(screen.getByTestId('t'), { button: 0, ctrlKey: true });
    expect(nav.calls).toHaveLength(1);
  });
});
