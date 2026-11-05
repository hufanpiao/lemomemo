// 液态玻璃底栏外壳（B2 FA-7）：页签、选中项、“＋”、液滴位置、读屏；首屏后部分（GlassBarFx：模糊带、按住放大）下载到以后的样子
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hrefOf } from '../../../../app/router.ts';
import { uiStore } from '../../../state/ui-store.ts';
import { GlassBar } from '../GlassBar.tsx';
import styles from '../GlassBar.module.css';

// 首屏后部分（GlassBarFx）里的副本引擎另有测试（motion/__tests__/glass-ghost.test.ts）；这里用替身（jsdom 没有 IntersectionObserver）
vi.mock('../../../../motion/glass-ghost.ts', () => ({ startGlass: () => ({ stop: () => undefined, poke: () => undefined }), playGel: () => true }));

beforeEach(() => act(() => uiStore.getState().setLocale('zh-CN')));
afterEach(cleanup);

const drop = (): HTMLElement => document.querySelector(`.${styles.drop}`) as HTMLElement;
/** 等首屏后部分（GlassBarFx.tsx，import() 按需下载）挂上：模糊带出现 */
const ready = (): Promise<void> => waitFor(() => expect(screen.getByTestId('tabbar-band')).toBeTruthy());

describe('GlassBar', () => {
  it('4 个页签都是链接（今天、日历、待办、随手记），只有选中的那个 aria-current="page"；导航有名字', () => {
    render(<GlassBar active="calendar" />);
    const nav = screen.getByRole('navigation', { name: '主导航' });
    const links = [...nav.querySelectorAll('a[data-tab]')];
    expect(links.map((a) => a.textContent)).toEqual(['今天', '日历', '待办', '随手记']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([hrefOf('today'), hrefOf('calendar'), hrefOf('todos'), hrefOf('notes')]);
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual([null, 'page', null, null]);
    // 图标、玻璃层、液滴不进读屏
    for (const svg of nav.querySelectorAll('svg')) expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(drop().getAttribute('aria-hidden')).toBe('true');
  });

  it('韩文页签', () => {
    act(() => uiStore.getState().setLocale('ko-KR'));
    render(<GlassBar active="today" />);
    expect([...screen.getByRole('navigation').querySelectorAll('a[data-tab]')].map((a) => a.textContent)).toEqual(['오늘', '캘린더', '할 일', '메모']);
    expect(screen.getByTestId('tabbar-settings').getAttribute('aria-label')).toBe('설정');
  });

  it('“＋”：传了才出，是带名字的按钮，点了调 onClick；没传不出', () => {
    const onClick = vi.fn();
    const view = render(<GlassBar active="todos" add={{ label: '新建待办', onClick }} />);
    const add = screen.getByRole('button', { name: '新建待办' });
    fireEvent.click(add);
    expect(onClick).toHaveBeenCalledTimes(1);
    view.unmount();
    render(<GlassBar active="notes" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('液滴按选中的页签放位置（--i）；模糊带、深色玻璃层不在首屏外壳里，首屏后部分下载到以后才出（主持人 11-05 首屏 ③），不进读屏', async () => {
    let go: (() => void) | null = null;
    const view = render(<GlassBar active="today" later={(fn) => (go = fn)} />);
    expect(drop().style.getPropertyValue('--i')).toBe('0');
    expect(screen.queryByTestId('tabbar-band')).toBeNull();
    const adTint = (): Element | null => screen.getByRole('navigation').querySelector(`.${styles.adTint}`);
    expect(adTint()).toBeNull(); // 自动深浅的深色玻璃层也在首屏后部分里
    // 电脑版侧栏最下面的设置入口（D5）在首屏外壳里：首屏后部分没到、下不来时宽屏也有设置入口（设计复审三 S1；窄屏 CSS 藏着）
    const me = screen.getByTestId('tabbar-settings');
    expect(me.parentElement).toBe(screen.getByRole('navigation'));
    expect(me.previousElementSibling?.getAttribute('data-tab')).toBe('notes');
    expect(me.getAttribute('href')).toBe(hrefOf('settings'));
    expect(me.getAttribute('aria-label')).toBe('设置');
    view.rerender(<GlassBar active="todos" later={(fn) => (go = fn)} />);
    expect(drop().style.getPropertyValue('--i')).toBe('2');
    expect(go).not.toBeNull();
    act(() => go?.());
    await ready();
    expect(screen.getByTestId('tabbar-band').getAttribute('aria-hidden')).toBe('true');
    expect(adTint()?.getAttribute('aria-hidden')).toBe('true');
    // 放进 nav 最后面（叠放靠 z-index：浅色那层上面、页签下面）；设置入口还是那一个，没有多出一份
    expect(screen.getByRole('navigation').lastElementChild).toBe(adTint());
    expect(screen.getAllByTestId('tabbar-settings')).toEqual([me]);
  });

  it('按住当前选中的页签：液滴 data-state="press"（放大 1.12）；松开、取消、移出都还原（设计动效评审 D3）', async () => {
    render(<GlassBar active="today" />);
    await ready();
    const nav = screen.getByRole('navigation');
    const on = screen.getByRole('link', { name: '今天' });
    for (const end of ['pointerUp', 'pointerCancel', 'pointerLeave'] as const) {
      fireEvent.pointerDown(on.querySelector('span') as HTMLElement); // 按在页签里的字上也算
      expect(drop().dataset['state']).toBe('press');
      fireEvent[end](nav);
      expect(drop().dataset['state']).toBeUndefined();
    }
  });

  it('按住别的页签、按在页签之间：不放大（液滴马上滑走就是反馈，D3）', async () => {
    render(<GlassBar active="today" />);
    await ready();
    fireEvent.pointerDown(screen.getByRole('link', { name: '日历' }));
    expect(drop().dataset['state']).toBeUndefined();
    fireEvent.pointerDown(screen.getByRole('navigation'));
    expect(drop().dataset['state']).toBeUndefined();
  });

  it('切页过渡中落在 <html> 上的点按：按坐标替底栏的页签或“＋”点一下（设计复审二 R4）；点在别处、目标不是 <html> 不管', async () => {
    const onAdd = vi.fn();
    render(<GlassBar active="today" add={{ label: '新建日程', onClick: onAdd }} />);
    await ready();
    const todos = screen.getByRole('link', { name: '待办' });
    const plus = screen.getByRole('button', { name: '新建日程' });
    const rect = (l: number, t: number) => ({ left: l, right: l + 60, top: t, bottom: t + 50, x: l, y: t, width: 60, height: 50, toJSON: () => ({}) });
    todos.getBoundingClientRect = () => rect(150, 700);
    plus.getBoundingClientRect = () => rect(300, 700);
    const clicked: string[] = [];
    todos.addEventListener('click', (e) => {
      e.preventDefault(); // 不真跳 hash
      clicked.push('todos');
    });
    const html = document.documentElement;
    fireEvent.click(html, { clientX: 170, clientY: 720 });
    expect(clicked).toEqual(['todos']);
    fireEvent.click(html, { clientX: 320, clientY: 720 });
    expect(onAdd).toHaveBeenCalledTimes(1);
    fireEvent.click(html, { clientX: 20, clientY: 100 }); // 不在底栏上
    fireEvent.click(document.body, { clientX: 170, clientY: 720 }); // 目标不是 <html>：正常点按，不代点
    expect(clicked).toEqual(['todos']);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('点页签：液滴马上往那边走，不等路由（D1）；路由到了照路由；后退回原页不按旧的点击画；按着修饰键点不算', () => {
    const view = render(<GlassBar active="today" />);
    const go = (name: string, init: MouseEventInit = {}): void => {
      const a = screen.getByRole('link', { name });
      a.addEventListener('click', (e) => e.preventDefault(), { once: true }); // 不真跳 hash
      fireEvent.click(a, init);
    };
    go('待办');
    expect(drop().style.getPropertyValue('--i')).toBe('2');
    expect(screen.getByRole('link', { name: '今天' }).getAttribute('aria-current')).toBe('page'); // 读屏的选中项照路由
    view.rerender(<GlassBar active="todos" />);
    expect(drop().style.getPropertyValue('--i')).toBe('2');
    view.rerender(<GlassBar active="today" />); // 后退
    expect(drop().style.getPropertyValue('--i')).toBe('0');
    go('日历', { ctrlKey: true });
    expect(drop().style.getPropertyValue('--i')).toBe('0');
  });

  it('样式：液滴只动 translate、scale（时长、曲线用令牌），两种减少动态效果都关掉；减少透明效果两种都换实色；切页名字登记过', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(import.meta.dirname, '../GlassBar.module.css'), 'utf8');
    const fxCss = readFileSync(join(import.meta.dirname, '../GlassBarFx.module.css'), 'utf8'); // 首屏后部分：模糊带、果冻后备
    expect(css).toContain('transition: translate var(--dur-drop) var(--ease-drop), scale var(--dur-drop-press) var(--ease-press);');
    expect(fxCss).toContain('animation: gel var(--dur-drop) var(--ease-gel);');
    expect(fxCss).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.jelly \{\s*animation: none;/);
    expect(fxCss).toMatch(/:global\(:root\[data-rt='1'\]\) \.band \{\s*display: none;/);
    expect(fxCss).toMatch(/\.band\[data-kb='1'\] \{\s*visibility: hidden;/);
    expect(css).not.toMatch(/\.band|\.jelly \{|@keyframes gel/); // 外壳的样式里没有首屏后部分的类
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.drop \{\s*transition: none;/);
    expect(fxCss).toMatch(/:global\(:root\[data-rm='1'\]\) \.jelly \{\s*animation: none;/);
    expect(css).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{\s*\.barTint \{\s*background: var\(--glass-solid\);/);
    expect(css).toMatch(/:global\(:root\[data-rt='1'\]\) \.barTint \{\s*background: var\(--glass-solid\);/);
    expect(css).toMatch(/\.drop\[data-state='press'\] \{\s*scale: 1\.12;/);
    expect(css).not.toContain('scale: 1.16');
    // 只藏底栏、“＋”、模糊带，不写成全局的 [data-kb] 选择器（设计复审一 R2）
    expect(css).toMatch(/\.bar\[data-kb='1'\],\s*\.fab\[data-kb='1'\] \{\s*visibility: hidden;/);
    expect(css).not.toMatch(/(^|\n)\[data-kb/);
    // “＋”聚焦只加焦点环，不覆盖底色圈、细灰边和阴影（R3）：写 box-shadow 的聚焦规则只有页签那条
    expect(css).toMatch(/\.tab:focus-visible,\s*\.fab:focus-visible \{\s*outline: 2px solid var\(--focus\);\s*\}/);
    expect(css).not.toMatch(/\.fab:focus-visible[^{]*\{[^}]*box-shadow/);
    // 减少透明效果：选中液滴换 --g-pill-solid 加描边（D2），两种都要
    expect(css.match(/background: var\(--g-pill-solid\);\s*box-shadow: inset 0 0 0 1\.5px var\(--g-pill-edge\);/g)?.length).toBe(2);
    const { VT_FIXED } = await import('../../../../motion/vt.ts');
    expect(Object.values(VT_FIXED)).toEqual(expect.arrayContaining(['tabbar', 'tabbar-add']));
  });
});
