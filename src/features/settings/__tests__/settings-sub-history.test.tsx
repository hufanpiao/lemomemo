// 设置子页的返回（提醒接线代码审查 H1、M1、M2、L1；R-487 起按返回栈）：点进来时上一层压进返回栈（history.state.lemoStack），
// 返回时栈顶就是上一层就退一步（和左边往右划同一条路），不是就原地换成上一层。这里每条都看栈，分清是退一步还是原地换，
// 并且最后再退一步，看是不是离开了设置（落到 #/today）；全程不许 pushState、history.back（浏览器历史只有一条）。
// 提醒（二级、三级）、日历、注销三类子页都测；审查探针 P5（去编辑页再回来）、刷新以后各一条。原来的 P2～P4（侧滑再“前进”）：没有“前进”了，删掉
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goBack, navigate, stackOf } from '../../../app/router.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import SettingsPage from '../ui/SettingsPage.tsx';
import { fakeApi, fakeExit, now } from './fakes.tsx';

vi.setConfig({ testTimeout: 15_000 });

let push: ReturnType<typeof vi.spyOn>;
let back: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  localStorage.clear();
  // 每条从“今天 → 设置”开始：返回栈里是今天（最后退一步应落到这里）
  window.history.replaceState({ lemoStack: ['#/today'] }, '', '#/settings');
  push = vi.spyOn(window.history, 'pushState');
  back = vi.spyOn(window.history, 'back');
});
afterEach(() => {
  expect(push).not.toHaveBeenCalled();
  expect(back).not.toHaveBeenCalled();
  cleanup();
  vi.restoreAllMocks();
});

const mount = () => render(<SettingsPage deps={{ api: fakeApi(), exit: fakeExit().exit, now }} />);
const click = async (id: string): Promise<void> => {
  const el = await screen.findByTestId(id, {}, { timeout: 10_000 });
  await act(async () => {
    fireEvent.click(el);
  });
};
const hashIs = (h: string) => waitFor(() => expect(window.location.hash).toBe(h), { timeout: 10_000 });
/** 左边往右划（tab-swipe 栈不空时调 goBack） */
const swipeBack = async (to: string): Promise<void> => {
  await act(async () => {
    goBack();
  });
  await hashIs(to);
};
/** 最后在设置首页再退一步：应该离开设置，回到今天（栈里没有多出来的东西） */
async function leavesSettings(): Promise<void> {
  expect(stackOf()).toEqual(['#/today']);
  await swipeBack('#/today');
  expect(stackOf()).toEqual([]);
}

describe('点进来再点返回：一律退一步', () => {
  it('提醒二级页、三级页（未来 7 天）一层一层退，最后再退一步就离开设置', async () => {
    mount();
    await click('settings-remind-entry');
    await hashIs('#/settings/remind');
    await click('remind-open-upcoming');
    await hashIs('#/settings/remind/upcoming');
    expect(stackOf()).toEqual(['#/today', '#/settings', '#/settings/remind']);
    await click('settings-remind-up-back');
    await hashIs('#/settings/remind');
    expect(stackOf()).toEqual(['#/today', '#/settings']);
    await click('settings-remind-back');
    await hashIs('#/settings');
    await leavesSettings();
  });

  it('日历二级页', async () => {
    mount();
    await click('settings-cal-entry');
    await hashIs('#/settings/calendar');
    await click('settings-cal-back');
    await hashIs('#/settings');
    await leavesSettings();
  });

  it.each([
    ['settings-account-entry', '#/settings/account', 'settings-account-back'],
    ['settings-data-entry', '#/settings/data', 'settings-data-back'],
    ['settings-about-entry', '#/settings/about', 'settings-about-back'],
  ])('合卡以后的二级页 %s（SETTINGS-merge-cards）', async (entry, hash, backId) => {
    mount();
    await click(entry);
    await hashIs(hash);
    await click(backId);
    await hashIs('#/settings');
    await leavesSettings();
  });

  it('注销账号页：从账号二级页点进去，退回账号二级页，再退回首页', async () => {
    mount();
    await click('settings-account-entry');
    await click('settings-delete-entry');
    await hashIs('#/settings/delete');
    await click('settings-delete-back');
    await hashIs('#/settings/account');
    await click('settings-account-back');
    await hashIs('#/settings');
    await leavesSettings();
  });
});

describe('R-347：“提醒里写什么”、免打扰两个三层页点进再返回', () => {
  it.each([
    ['remind-open-show-title', '#/settings/remind/show-title', 'settings-remind-st-back', 'settings-remind-show-title'],
    ['remind-open-dnd', '#/settings/remind/dnd', 'settings-remind-dnd-back', 'settings-remind-dnd'],
  ])('%s：进去是自己的页，返回退一步，焦点回入口，最后离开设置', async (entry, hash, backId, body) => {
    mount();
    await click('settings-remind-entry');
    await click(entry);
    await hashIs(hash);
    expect(await screen.findByTestId(body, {}, { timeout: 10_000 })).toBeTruthy();
    await click(backId);
    await hashIs('#/settings/remind');
    expect(stackOf()).toEqual(['#/today', '#/settings']);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId(entry)), { timeout: 10_000 });
    await click('settings-remind-back');
    await hashIs('#/settings');
    await leavesSettings();
  });
});

describe('直接打开的子页：原地换成上一层，栈不动', () => {
  it.each([
    ['#/settings/remind', 'settings-remind-back', '#/settings'],
    ['#/settings/remind/upcoming', 'settings-remind-up-back', '#/settings/remind'],
    ['#/settings/remind/show-title', 'settings-remind-st-back', '#/settings/remind'],
    ['#/settings/remind/dnd', 'settings-remind-dnd-back', '#/settings/remind'],
    ['#/settings/calendar', 'settings-cal-back', '#/settings'],
    ['#/settings/delete', 'settings-delete-back', '#/settings/account'],
    ['#/settings/account', 'settings-account-back', '#/settings'],
    ['#/settings/data', 'settings-data-back', '#/settings'],
    ['#/settings/about', 'settings-about-back', '#/settings'],
  ])('%s', async (start, backId, to) => {
    window.history.replaceState(null, '', start);
    mount();
    await click(backId);
    await hashIs(to);
    expect(stackOf()).toEqual([]);
  });
});

describe('审查探针：栈跟着那条历史走', () => {
  it('P5（H1）：未来 7 天 → 去编辑页 → 退回来（设置页重新挂载）→ 一层一层返回 → 首页再退一步离开设置', async () => {
    mount();
    await click('settings-remind-entry');
    await click('remind-open-upcoming');
    await hashIs('#/settings/remind/upcoming');
    // 点一条去编辑页：设置页卸载
    cleanup();
    await navigate('event', 'x');
    await swipeBack('#/settings/remind/upcoming');
    mount();
    await click('settings-remind-up-back');
    await hashIs('#/settings/remind');
    await click('settings-remind-back');
    await hashIs('#/settings');
    await leavesSettings();
  });

  it('刷新以后：点进提醒、刷新（重新挂载，history.state 还在），点返回仍退一步', async () => {
    mount();
    await click('settings-remind-entry');
    await hashIs('#/settings/remind');
    cleanup();
    mount();
    await click('settings-remind-back');
    await hashIs('#/settings');
    await leavesSettings();
  });
});

describe('L1：退回上一层以后焦点回到进来时点的那一行', () => {
  it.each([
    ['settings-remind-entry', 'settings-remind-back'],
    ['settings-cal-entry', 'settings-cal-back'],
    ['settings-account-entry', 'settings-account-back'],
    ['settings-data-entry', 'settings-data-back'],
    ['settings-about-entry', 'settings-about-back'],
  ])('点 %s 进去，%s 回来', async (entry, backId) => {
    mount();
    await click(entry);
    await click(backId);
    await hashIs('#/settings');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId(entry)), { timeout: 10_000 });
  });

  it('注销页回账号二级页：焦点回到“注销账号”那一行', async () => {
    mount();
    await click('settings-account-entry');
    await click('settings-delete-entry');
    await click('settings-delete-back');
    await hashIs('#/settings/account');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('settings-delete-entry')), { timeout: 10_000 });
  });

  it('S1：回到首页时滚动位置还原成点进去之前的，焦点放回入口时不再滚', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    mount();
    const entry = await screen.findByTestId('settings-about-entry');
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 420 });
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    await click('settings-about-entry');
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    await click('settings-about-back');
    await hashIs('#/settings');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('settings-about-entry')), { timeout: 10_000 });
    expect(scrollTo).toHaveBeenCalledWith(0, 420);
    // 首页重新挂载，入口是新的节点：放回焦点时带 preventScroll，不把还原好的位置再滚走
    const again = screen.getByTestId('settings-about-entry');
    expect(again).not.toBe(entry);
    const i = focus.mock.contexts.lastIndexOf(again);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(focus.mock.calls[i]?.[0]).toMatchObject({ preventScroll: true });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  });

  it('S2：只在首页点进去时记滚动位置；二级页里再往下点（账号 → 注销）不覆盖，回首页还原的是首页那一次的', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const at = (y: number) => Object.defineProperty(window, 'scrollY', { configurable: true, value: y });
    try {
      mount();
      await screen.findByTestId('settings-account-entry');
      at(420);
      await click('settings-account-entry');
      await hashIs('#/settings/account');
      at(777);
      await click('settings-delete-entry');
      await hashIs('#/settings/delete');
      await click('settings-delete-back');
      await hashIs('#/settings/account');
      at(0);
      await click('settings-account-back');
      await hashIs('#/settings');
      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 420), { timeout: 10_000 });
      expect(scrollTo).not.toHaveBeenCalledWith(0, 777);
    } finally {
      at(0);
    }
  });

  it('三层页回提醒二级页：焦点回到“未来 7 天的提醒”那一行；左边往右划回来也一样', async () => {
    mount();
    await click('settings-remind-entry');
    await click('remind-open-upcoming');
    await click('settings-remind-up-back');
    await hashIs('#/settings/remind');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('remind-open-upcoming')), { timeout: 10_000 });
    await click('remind-open-upcoming');
    await hashIs('#/settings/remind/upcoming');
    await swipeBack('#/settings/remind');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('remind-open-upcoming')), { timeout: 10_000 });
  });
});

describe('L2：返回按钮的读屏名不带“‹”', () => {
  it('二级页、注销页的返回按钮：“‹”藏起来，读屏名只有上一层的名字', async () => {
    mount();
    await click('settings-remind-entry');
    const btn = await screen.findByTestId('settings-remind-back');
    expect(btn.querySelector('[aria-hidden="true"]')?.textContent).toBe('‹');
    expect(screen.getByRole('button', { name: '设置' })).toBe(btn);
    await click('settings-remind-back');
    await click('settings-account-entry');
    await click('settings-delete-entry');
    const del = await screen.findByTestId('settings-delete-back');
    expect(del.querySelector('[aria-hidden="true"]')?.textContent).toBe('‹');
    // 注销页的上一层是账号二级页（合卡以后），读屏名就是“账号”
    expect(screen.getByRole('button', { name: '账号' })).toBe(del);
  });
});
