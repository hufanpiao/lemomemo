// 设置页两件小事（10-30）：
// ① R-275 账号标题下一行当前登录邮箱：只显示、读本机会话不联网；读不到（null、读出错）这一行整行不出，不留空白；读屏前面多读一个“当前登录邮箱”（中韩）
// ② 组间距（负责人 14:55：注销卡片和“界面语言”卡片紧贴）：各组装在一个纵向 flex 容器 .groups 里，gap 16px，不靠外边距合并。
//    合卡以后（SETTINGS-merge-cards）.groups 里装的是三张卡；邮箱挪到账号二级页最上面，首页“账号”一行的名字就是邮箱
//    jsdom 不算布局，间距按 CSS 源码核对
import { readFileSync } from 'node:fs';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { sessionStorageKey } from '../../../platform/session.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import SettingsPage from '../ui/SettingsPage.tsx';
import { fakeApi, fakeExit, now, text } from './fakes.tsx';

const LONG = 'a.very.long.mailbox.name.for.testing.wrap@example-subdomain.lemo-notes.co.kr';

/** 默认直接打开账号二级页（邮箱在这一页最上面），等设备列表读完 */
async function renderWith(readEmail?: () => string | null, hash = '#/settings/account') {
  window.history.replaceState(null, '', hash);
  render(<SettingsPage deps={{ api: fakeApi(), exit: fakeExit().exit, now, ...(readEmail ? { readEmail } : {}) }} />);
  if (hash === '#/settings') await waitFor(() => expect(screen.getByTestId('settings-account-summary').textContent).toMatch(/[0-9]/));
  else await waitFor(() => expect(screen.getAllByTestId('settings-device').length).toBeGreaterThan(0));
}

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  localStorage.clear();
});
afterEach(cleanup);

describe('R-275 设置 › 账号：当前登录邮箱', () => {
  it('有邮箱：账号二级页最上面显示邮箱本身，读屏前缀是“当前登录邮箱”', async () => {
    await renderWith(() => LONG);
    const line = screen.getByTestId('settings-account-email');
    expect(line.previousElementSibling).toBeNull();
    expect(line.parentElement?.getAttribute('data-section')).toBe('account');
    expect(text(line)).toBe(`${zh['settings.account.email']}${LONG}`);
    expect(line.tagName).toBe('P');
    // 屏幕上只显示邮箱：标签放在只给读屏的 span 里
    const label = line.querySelector('span');
    expect(text(label)).toBe(zh['settings.account.email']);
    expect(label?.className).not.toBe('');
  });

  it('韩文界面：读屏标签换成韩文，邮箱原样', async () => {
    uiStore.getState().setLocale('ko-KR');
    await renderWith(() => LONG);
    expect(text(screen.getByTestId('settings-account-email'))).toBe(`${ko['settings.account.email']}${LONG}`);
  });

  it('读不到邮箱（null）：这一行不出现', async () => {
    await renderWith(() => null);
    expect(screen.queryByTestId('settings-account-email')).toBeNull();
  });

  it('首页“账号”一行：有邮箱时行名就是邮箱，读不到时写“账号”', async () => {
    await renderWith(() => LONG, '#/settings');
    expect(text(screen.getByTestId('settings-account-entry'))).toContain(LONG);
    cleanup();
    await renderWith(() => null, '#/settings');
    expect(text(screen.getByTestId('settings-account-entry'))).toContain(zh['settings.account.title']);
  });

  it('读邮箱出错：当作读不到，这一行不出现，页面照常', async () => {
    await renderWith(() => {
      throw new Error('boom');
    });
    expect(screen.queryByTestId('settings-account-email')).toBeNull();
    expect(screen.getByRole('heading', { name: zh['settings.account.title'] })).toBeTruthy();
  });

  it('默认从本机会话读（platform/session.ts 的 readSessionEmail）：localStorage 里有会话就显示那个邮箱', async () => {
    // 键名照 findKey：配了 supabaseUrl 就是 sessionStorageKey() 那一个；没配（测试环境可能如此）按 sb-*-auth-token 扫
    const key = sessionStorageKey() ?? 'sb-lemotest-auth-token';
    localStorage.setItem(key, JSON.stringify({ access_token: 'h.p.s', user: { id: 'u-1', email: 'me@lemo.test' } }));
    await renderWith();
    expect(text(screen.getByTestId('settings-account-email'))).toBe(`${zh['settings.account.email']}me@lemo.test`);
  });

  it('首页“账号”一行的名字是邮箱：只在“@”前、“.”后插 <wbr>，优先在这些地方断行（韩文复审建议）；读出来的字不变', async () => {
    await renderWith(() => LONG, '#/settings');
    const row = screen.getByTestId('settings-account-entry');
    const label = screen.getByTestId('settings-account-summary').previousElementSibling as HTMLElement;
    expect(label.textContent).toBe(LONG);
    const breaks = [...label.querySelectorAll('wbr')];
    expect(breaks).toHaveLength([...LONG].filter((c) => c === '.' || c === '@').length);
    for (const w of breaks) {
      const before = w.previousSibling?.textContent ?? '';
      const after = w.nextSibling?.textContent ?? '';
      expect(before.endsWith('.') || after.startsWith('@'), `${before}|${after}`).toBe(true);
    }
    expect(row.contains(label)).toBe(true);
  });

  it('S5：账号二级页最上面那行邮箱也在“@”前、“.”后插 <wbr>，和首页一行断法一致；读出来的字不变', async () => {
    await renderWith(() => LONG);
    const line = screen.getByTestId('settings-account-email');
    expect(text(line)).toBe(`${zh['settings.account.email']}${LONG}`);
    expect(line.querySelectorAll('wbr')).toHaveLength([...LONG].filter((c) => c === '.' || c === '@').length);
  });

  it('默认读法、没有会话：这一行不出现', async () => {
    await renderWith();
    expect(screen.queryByTestId('settings-account-email')).toBeNull();
  });
});

const css = readFileSync('src/features/settings/ui/SettingsPage.module.css', 'utf8');
function block(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) return '';
  return css.slice(at, css.indexOf('}', at));
}

describe('设置页组间距', () => {
  it('三张卡装在同一个外层容器 .groups 里，卡和卡之间靠外层的间距隔开', async () => {
    await renderWith(() => null, '#/settings');
    const cards = [...document.querySelectorAll('[data-testid^="settings-card-"]')];
    expect(cards).toHaveLength(3);
    expect(new Set(cards.map((s) => s.parentElement)).size).toBe(1);
    expect(cards[0]?.parentElement?.className).not.toBe('');
    expect(cards[0]?.parentElement?.tagName).toBe('DIV');
    expect(cards.every((c) => c.tagName === 'SECTION')).toBe(true);
  });

  it('CSS：外层 .groups 是纵向 flex、gap 16px（不靠外边距合并）；二级页里的小标题（已登录设备、最近的导出）照旧 16px', () => {
    const g = block('.groups');
    expect(g).toMatch(/display: flex;/);
    expect(g).toMatch(/flex-direction: column;/);
    expect(g).toMatch(/gap: 16px;/);
    // “设置”标题到第一组：.top 下边距 8 + .groups 上内边距 8 = 16
    expect(g).toMatch(/padding-top: 8px;/);
    expect(block('.top')).toMatch(/margin-bottom: 8px;/);
    expect(block('.gt')).toMatch(/margin: 16px 4px 6px;/);
    // 旧写法不留（合卡以后没有 .slot 了）
    expect(css).not.toMatch(/\.slot\b/);
    // 组末尾常驻的空播报区（导出状态）不占位置，组底到“退出登录”的距离和改前一样
    expect(block('.status:empty')).toMatch(/margin-top: 0;/);
  });

  it('R-276：单行 .row 整行高 44、不加上下内边距；两行内容（带 .meta）的行上下 8px；行里的 .rowBtn 仍 44 撑满整行', () => {
    const row = block('.row');
    expect(row).toMatch(/min-height: var\(--hit\);/);
    expect(row).toMatch(/padding: 0;/);
    expect(block('.row:has(> .meta)')).toMatch(/padding: 8px 0;/);
    expect(block('.rowBtn')).toMatch(/min-height: var\(--hit\);/);
    // 行里的标题（“界面语言”是 h2）去掉默认外边距，不把 44 的行撑高
    expect(block('.tx')).toMatch(/margin: 0;/);
  });

  it('R-276/R-282：分段控件外框（.seg 上下内边距 + .segBtn 高）看得见 38、和本页其他按钮一样，在 44 的行里上下各留 3；数从 kit 的 CSS 源码里取（合卡以后语言行用 kit 的 SettingsSegRow）', () => {
    const kit = readFileSync('src/kit/components/Settings/Settings.module.css', 'utf8');
    const kitBlock = (sel: string): string => {
      const at = kit.indexOf(`\n${sel} {`);
      return at < 0 ? '' : kit.slice(at, kit.indexOf('}', at));
    };
    const pad = /padding: (\d+)px;/.exec(kitBlock('.seg'))?.[1];
    const btnH = /min-height: (\d+)px;/.exec(kitBlock('.segBtn'))?.[1];
    expect(pad).toBeDefined();
    expect(btnH).toBeDefined();
    expect(Number(btnH)).toBe(32);
    expect(2 * Number(pad) + Number(btnH)).toBe(38);
    expect((44 - (2 * Number(pad) + Number(btnH))) / 2).toBe(3);
  });

  it('R-277：页面最底下的“退出登录”另加 .signOut 撑到 44，写在 .btn 之后才压得住 38', () => {
    expect(block('.signOut')).toMatch(/min-height: var\(--hit\);/);
    expect(css.indexOf('\n.signOut {')).toBeGreaterThan(css.indexOf('\n.btn {'));
    const tsx = readFileSync('src/features/settings/ui/SettingsPage.tsx', 'utf8');
    expect(tsx).toMatch(/styles\.signOut/);
  });

  it('R-276：.btn 和确认弹窗的 .primary 看得见 38；两者都用 ::after 把点击区扩到 44（分段按钮的在 kit，见 Settings.test.tsx）', () => {
    const btn = block('.btn');
    expect(btn).toMatch(/min-height: 38px;/);
    expect(btn).toMatch(/position: relative;/);
    expect(btn).toMatch(/font-size: var\(--fs-14\);/);
    // 确认弹窗的确认按钮和“取消”一样高（负责人 10-30）；本模块的 .primary 只在设置里用，字号不变
    const primary = block('.primary');
    expect(primary).toMatch(/min-height: 38px;/);
    expect(primary).toMatch(/position: relative;/);
    expect(primary).toMatch(/font-size: var\(--fs-15\);/);
    // 扩点击区：两个选择器共用一条规则，写法同皮肤视觉稿第 133 行
    const at = css.indexOf('\n.btn::after,\n.primary::after {');
    expect(at).toBeGreaterThan(0);
    const after = css.slice(at, css.indexOf('}', at));
    expect(after).toMatch(/content: '';/);
    expect(after).toMatch(/position: absolute;/);
    expect(after).toMatch(/width: max\(100%, var\(--hit\)\);/);
    expect(after).toMatch(/height: max\(100%, var\(--hit\)\);/);
    expect(after).toMatch(/transform: translate\(-50%, -50%\);/);
  });

  it('CSS：邮箱那一行是正文色、正文（15）的次一级 14，和灰色 13 的组标题分开；长邮箱任意处换行；读屏标签视觉上隐藏', async () => {
    const e = block('.email');
    expect(e).toMatch(/color: var\(--text\);/);
    expect(e).toMatch(/font-size: var\(--fs-14\);/);
    expect(e).toMatch(/overflow-wrap: anywhere;/);
    expect(block('.gt')).toMatch(/color: var\(--text-2\);/);
    expect(block('.gt')).toMatch(/font-size: var\(--fs-13\);/);
    expect(block('.srOnly')).toMatch(/clip-path: inset\(50%\);/);
    // 不再挂次要文字 .sn（否则颜色字号跟着组标题一样灰、小）
    await renderWith(() => LONG);
    expect(screen.getByTestId('settings-account-email').classList.length).toBe(1);
  });
});
