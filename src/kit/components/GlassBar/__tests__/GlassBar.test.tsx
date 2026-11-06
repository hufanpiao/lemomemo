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
/** 等首屏后部分（GlassBarFx.tsx，import() 按需下载）挂上：模糊带出现，再用 act 把它的 useEffect 跑完。
 *  GLASSBAR-html-tap-flaky（11-06）：模糊带一进 DOM waitFor 就放行，但挂 <html> 点击、nav 按下监听的是被动 effect，
 *  全量跑在负载下时它还没执行，紧接着的 fireEvent 落空（expected [] to deeply equal [ 'todos' ]）；act 结束前 React 一定把 effect 冲掉 */
const ready = async (): Promise<void> => {
  await waitFor(() => expect(screen.getByTestId('tabbar-band')).toBeTruthy());
  await act(async () => undefined);
};

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

  it('液滴按选中的页签放位置（--i）；底部实色带不在首屏外壳里，首屏后部分下载到以后才出（主持人 11-05 首屏 ③），不进读屏', async () => {
    let go: (() => void) | null = null;
    const view = render(<GlassBar active="today" later={(fn) => (go = fn)} />);
    expect(drop().style.getPropertyValue('--i')).toBe('0');
    expect(screen.queryByTestId('tabbar-band')).toBeNull();
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
    expect(screen.getByTestId('tabbar-band').children.length).toBe(0); // 只是一层实色，没有模糊层
    // 自动深浅 11-06 取消：nav 里没有深色玻璃层；设置入口还是那一个，没有多出一份
    expect(screen.getByRole('navigation').querySelector('[class*="adTint"]')).toBeNull();
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

  it('实色带防回退（对比度清单 g-tint-floor、g-fg-on-floor 按 over: ["--bg"] 算的前提）：从底栏、“＋”顶边到屏幕底是不透明的 --bg', async () => {
    // 这条挂了：实色带被改成半透明或起点低于底栏顶边，底栏后面又会透出内容，build/contrast-pairs.json 那两项要去掉 over、重算例外（主持人 11-06）
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '');
    const css = strip(readFileSync(join(import.meta.dirname, '../GlassBar.module.css'), 'utf8'));
    const fxCss = strip(readFileSync(join(import.meta.dirname, '../GlassBarFx.module.css'), 'utf8'));
    // 顶层同名规则合在一起看（.bar、.fab 前面还有一条“.bar, .fab {”共用规则）
    const RULES: Record<string, RegExp> = { '.bar': /\n\.bar \{([^}]*)\}/g, '.fab': /\n\.fab \{([^}]*)\}/g, '.band': /\n\.band \{([^}]*)\}/g };
    const rule = (src: string, sel: string): string => [...src.matchAll(RULES[sel] ?? /$^/g)].map((x) => x[1]).join('\n');
    const px = (block: string, prop: string): number => Number(new RegExp(String.raw`${prop}: (?:calc\()?(\d+)px`).exec(block)?.[1] ?? NaN);
    // 顶边离屏幕底（不算安全区）：底栏 8 + 62 = 70，“＋” 6 + 66 = 72
    const top = Math.max(px(rule(css, '.bar'), 'bottom') + px(rule(css, '.bar'), 'height'), px(rule(css, '.fab'), 'bottom') + px(rule(css, '.fab'), 'height'));
    expect(top).toBe(72);
    const band = rule(fxCss, '.band');
    // 带子高 = 实色起点（离屏幕底 solid px）+ 渐隐段 --band-fade + 安全区；铺到屏幕底
    const m = /height: calc\((\d+)px \+ var\(--band-fade\) \+ env\(safe-area-inset-bottom\)\);/.exec(band);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(top);
    expect(band).toMatch(/bottom: 0;/);
    // 渐隐段走完以后一直是 --bg（不透明），整层没有 opacity、没有混合、没有半透明色
    expect(band).toContain('background: linear-gradient(to bottom, transparent 0, var(--bg) var(--band-fade), var(--bg) 100%);');
    expect(band).not.toMatch(/opacity|mix-blend|rgba|color-mix/);
    expect(fxCss).not.toMatch(/\.band[^{]*\{[^}]*opacity/);
    // --bg 在四套皮肤里都是实色
    for (const f of ['glass', 'simple']) {
      const skin = readFileSync(join(import.meta.dirname, `../../../../styles/skins/${f}.css`), 'utf8');
      const bgs = [...skin.matchAll(/--bg:([^;]+);/g)].map((x) => x[1]);
      expect(bgs.length).toBe(2);
      for (const v of bgs) expect(v).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('样式：液滴只动 translate、scale（时长、曲线用令牌），两种减少动态效果都关掉；减少透明效果两种都换实色；切页名字登记过', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(import.meta.dirname, '../GlassBar.module.css'), 'utf8');
    const fxCss = readFileSync(join(import.meta.dirname, '../GlassBarFx.module.css'), 'utf8'); // 首屏后部分：模糊带、果冻后备
    expect(css).toContain('transition: translate var(--dur-drop) var(--ease-drop), scale var(--dur-drop-press) var(--ease-press);');
    expect(fxCss).toContain('animation: gel var(--dur-drop) var(--ease-gel);');
    expect(fxCss).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.jelly \{\s*animation: none;/);
    // 减少透明效果：带子照样在，而且是硬边实色（渐隐那段也不要）
    for (const re of [/@media \(prefers-reduced-transparency: reduce\) \{\s*\.band \{\s*background: linear-gradient\(to bottom, transparent var\(--band-fade\), var\(--bg\) var\(--band-fade\)\);/, /:global\(:root\[data-rt='1'\]\) \.band \{\s*background: linear-gradient\(to bottom, transparent var\(--band-fade\), var\(--bg\) var\(--band-fade\)\);/]) expect(fxCss).toMatch(re);
        expect(fxCss).toMatch(/@media \(width >= 900px\) \{\s*\.band \{\s*display: none;/);
    expect(fxCss).toMatch(/\.band\[data-kb='1'\] \{\s*visibility: hidden;/);
    expect(css).not.toMatch(/\.band|\.jelly \{|@keyframes gel/); // 外壳的样式里没有首屏后部分的类
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.drop \{\s*transition: none;/);
    expect(fxCss).toMatch(/:global\(:root\[data-rm='1'\]\) \.jelly \{\s*animation: none;/);
    expect(css).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{\s*\.barTint \{\s*background: var\(--glass-solid\);/);
    expect(css).toMatch(/:global\(:root\[data-rt='1'\]\) \.barTint \{\s*background: var\(--glass-solid\);/);
    expect(css).toMatch(/\.drop\[data-state='press'\] \{\s*scale: 1\.12;/);
    // 11-06 真机 9d40848：过渡中不再换实色（负责人不接受“先不透明再变透明”），没有 ::after 遮罩；快照组裁圆角见 view-transition-css.test.ts
    expect(css).not.toMatch(/::after \{[^}]*--glass-solid|active-view-transition|data-vt/);
    const fx2 = fxCss.replace(/\/\*[\s\S]*?\*\//g, '');
    // 底部实色带（11-06 负责人）：从“＋”顶边（离屏幕底 72px）往上 --band-fade 起，一直铺到屏幕底（含安全区）；上沿 --band-fade 一段透明→--bg，往下不透明；只有颜色、不模糊
    expect(fx2).toMatch(/\.band \{[^}]*height: calc\(72px \+ var\(--band-fade\) \+ env\(safe-area-inset-bottom\)\);[^}]*background: linear-gradient\(to bottom, transparent 0, var\(--bg\) var\(--band-fade\), var\(--bg\) 100%\);/);
    expect(fx2).not.toMatch(/backdrop-filter|opacity|\.band [ib]\b/);
    const base = readFileSync(join(import.meta.dirname, '../../../../styles/base.css'), 'utf8');
    expect(base).toMatch(/--band-fade: 24px;/);
    expect(css).not.toContain('scale: 1.16');
    // 11-06 底栏透明度排查：副本档直接模糊背后的真实画面（--g-live-fx，3px）；没有 0.5px 外圈；后备 8px；阴影两层
    expect(css).toMatch(/\.bar\[data-glass='copy'\],\s*\.fab\[data-glass='copy'\] \{\s*backdrop-filter: var\(--g-live-fx\);/);
    expect(css).toMatch(/\.bar\[data-glass='copy'\] \.barTint \{\s*background: var\(--g-tint\);\s*\}/);
    // 带 view-transition-name 的 .bar、.fab 是背景根：模糊只能写在它们自己身上，里面的着色层、液滴一律不写 backdrop-filter（第二轮根因 2）
    expect(css).not.toMatch(/\.(glass|barTint|fabTint|adTint|pill)\b[^{]*\{[^}]*backdrop-filter: (?!none)/);
    expect(css).not.toContain('data-glass-layer'); // 11-06 起副本引擎不再建副本层（GLASS-copy-unused），样式里也不用再藏它
    expect(css).not.toContain('var(--rim-shade)');
    expect(css).toContain('backdrop-filter: blur(8px) saturate(1.8);');
    expect(css).not.toContain('var(--shadow-2)');
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
