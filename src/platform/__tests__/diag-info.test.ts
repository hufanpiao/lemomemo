// 诊断信息（platform/diag-info.ts，11-06）：第一行构建信息，接着 SW、样式表、写法支持、底栏和顶部带的计算样式；只读、不抛、不发请求、不写存储
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectDiag } from '../diag-info.ts';

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-rt');
  vi.restoreAllMocks();
});

describe('collectDiag', () => {
  it('第一行是构建提交号、版本；有底栏时列出它的 data-glass 和计算样式；顶部带三层（两层模糊元素、底色条）都有一行', async () => {
    const nav = document.createElement('nav');
    nav.dataset['testid'] = 'tabbar';
    nav.dataset['glass'] = 'copy';
    const plus = document.createElement('button');
    document.body.append(nav, plus);
    document.documentElement.dataset['rt'] = '1';
    const lines = await collectDiag();
    expect(lines[0]).toMatch(/^build: commit=\S+ version=\S+ builtAt=/);
    expect(lines[1]).toMatch(/^sw/);
    expect(lines.some((l) => l.startsWith('caches:') || l === 'sw: unsupported')).toBe(true);
    expect(lines).toContain('bar.data-glass=copy');
    expect(lines.find((l) => l.startsWith('html:'))).toMatch(/data-rt=1/);
    for (const name of ['.bar:', '.fab:', '.lemo-top-8:', 'body::before:', '.lemo-top-2:']) {
      expect(lines.some((l) => l.startsWith(name)), name).toBe(true);
    }
    expect(lines.find((l) => l.startsWith('.bar:'))).toMatch(/-webkit-backdrop-filter=/);
    expect(lines.find((l) => l.startsWith('geo:'))).toMatch(/env-top=\S* --inset-top=.* fixedTop0=.* #root\.padding-top=.* banner=(true|false)/);
    expect(lines.find((l) => l.startsWith('launch:'))).toMatch(/^launch: standalone=(true|false) painted=\S+ ready=\S+\((quiet|max|off|wait)\)/); // G10 启动时间线
    expect(document.body.children.length).toBe(2); // 量安全区用的临时元素已经拿掉
    expect(lines.find((l) => l.startsWith('supports:'))).toMatch(/-webkit-backdrop-filter=(true|false) backdrop-filter=(true|false) nospace=(true|false)/);
  });

  it('geo 行带 screen-inner = screen.height − innerHeight（11-10 主屏幕版少算状态栏那一截时一眼看出）', async () => {
    vi.spyOn(window.screen, 'height', 'get').mockReturnValue(956);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(894);
    const lines = await collectDiag();
    expect(lines.find((l) => l.startsWith('geo:'))).toMatch(/ inner=\d+x894 screen=\d+x956 screen-inner=62 vv=/);
  });

  it('没有底栏（键盘弹着、别的页面）写 absent；不发请求、不写本机存储', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const setSpy = vi.spyOn(Storage.prototype, 'setItem');
    const lines = await collectDiag();
    expect(lines).toContain('.bar: absent');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('CSS.supports、matchMedia 拿不到也不抛', async () => {
    vi.spyOn(CSS, 'supports').mockImplementation(() => {
      throw new Error('x');
    });
    const lines = await collectDiag();
    expect(lines.find((l) => l.startsWith('supports:'))).toMatch(/=false/);
  });
});
