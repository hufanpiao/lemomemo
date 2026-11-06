// 设置子页的返回（提醒接线代码审查 H1、M1、M2、L1）：“是点进来的”记在那条历史自己的 history.state 上（router 的 navigateSub / isSubEntry），
// 返回时有记号就退一步（history.back，和侧滑同一条路），没有就原地换成上一层（replaceState）。这里每条都分清是 back 还是 replace：
// spy history.back 和 history.replaceState，并且最后再退一步，看是不是离开了设置（落到 #/today），不只看 history.length。
// 提醒（二级、三级）、日历、注销三类子页都测；审查探针 P2～P5（侧滑再前进、去编辑页再回来、刷新以后）各一条
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import SettingsPage from '../ui/SettingsPage.tsx';
import { fakeApi, fakeExit, now } from './fakes.tsx';

vi.setConfig({ testTimeout: 15_000 });

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  localStorage.clear();
  // 每条从“今天 → 设置”开始：设置首页是点进来的普通页，再往前是今天（最后退一步应落到这里）
  window.history.replaceState(null, '', '#/today');
  window.history.pushState({ lemoDepth: 1 }, '', '#/settings');
});
afterEach(() => {
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
const swipeBack = async (to: string): Promise<void> => {
  await act(async () => {
    window.history.back();
  });
  await hashIs(to);
};
const forward = async (to: string): Promise<void> => {
  await act(async () => {
    window.history.forward();
  });
  await hashIs(to);
};
/** 从现在起记下 back 和 replaceState（都照常执行） */
function spyHistory() {
  const back = vi.spyOn(window.history, 'back');
  const replace = vi.spyOn(window.history, 'replaceState');
  return { back, replace, reset: () => { back.mockClear(); replace.mockClear(); } };
}
/** 最后在设置首页再退一步：应该离开设置，回到今天（没有多压的废历史） */
async function leavesSettings(): Promise<void> {
  await swipeBack('#/today');
}

describe('点进来再点返回：一律退一步，不 replace', () => {
  it('提醒二级页、三级页（未来 7 天）一层一层退，最后再退一步就离开设置', async () => {
    mount();
    await click('settings-remind-entry');
    await hashIs('#/settings/remind');
    await click('remind-open-upcoming');
    await hashIs('#/settings/remind/upcoming');
    const h = spyHistory();
    await click('settings-remind-up-back');
    await hashIs('#/settings/remind');
    await click('settings-remind-back');
    await hashIs('#/settings');
    expect(h.back).toHaveBeenCalledTimes(2);
    expect(h.replace).not.toHaveBeenCalled();
    await leavesSettings();
  });

  it('日历二级页', async () => {
    mount();
    await click('settings-cal-entry');
    await hashIs('#/settings/calendar');
    const h = spyHistory();
    await click('settings-cal-back');
    await hashIs('#/settings');
    expect(h.back).toHaveBeenCalledTimes(1);
    expect(h.replace).not.toHaveBeenCalled();
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
    const h = spyHistory();
    await click(backId);
    await hashIs('#/settings');
    expect(h.back).toHaveBeenCalledTimes(1);
    expect(h.replace).not.toHaveBeenCalled();
    await leavesSettings();
  });

  it('注销账号页：从账号二级页点进去，退回账号二级页，再退回首页', async () => {
    mount();
    await click('settings-account-entry');
    await click('settings-delete-entry');
    await hashIs('#/settings/delete');
    const h = spyHistory();
    await click('settings-delete-back');
    await hashIs('#/settings/account');
    await click('settings-account-back');
    await hashIs('#/settings');
    expect(h.back).toHaveBeenCalledTimes(2);
    expect(h.replace).not.toHaveBeenCalled();
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
    const h = spyHistory();
    await click(backId);
    await hashIs('#/settings/remind');
    expect(h.back).toHaveBeenCalledTimes(1);
    expect(h.replace).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId(entry)), { timeout: 10_000 });
    await click('settings-remind-back');
    await hashIs('#/settings');
    await leavesSettings();
  });
});

describe('直接打开的子页：原地换成上一层（replace），不调 back', () => {
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
    window.history.replaceState({ lemoDepth: 1 }, '', start);
    mount();
    const h = spyHistory();
    await click(backId);
    await hashIs(to);
    expect(h.back).not.toHaveBeenCalled();
    expect(h.replace).toHaveBeenCalledTimes(1);
  });
});

describe('审查探针：记号跟着那条历史走', () => {
  it('P2：未来 7 天 → 侧滑回提醒 → 前进回未来 7 天，再点两次返回：都退一步，一次就到，最后离开设置', async () => {
    mount();
    await click('settings-remind-entry');
    await click('remind-open-upcoming');
    await hashIs('#/settings/remind/upcoming');
    await swipeBack('#/settings/remind');
    await forward('#/settings/remind/upcoming');
    const h = spyHistory();
    await click('settings-remind-up-back');
    await hashIs('#/settings/remind');
    await click('settings-remind-back');
    await hashIs('#/settings');
    expect(h.back).toHaveBeenCalledTimes(2);
    expect(h.replace).not.toHaveBeenCalled();
    await leavesSettings();
  });

  it('P3：提醒 → 侧滑回首页 → 前进回提醒，点返回：退一步，不多压一条', async () => {
    mount();
    await click('settings-remind-entry');
    await hashIs('#/settings/remind');
    await swipeBack('#/settings');
    await forward('#/settings/remind');
    const h = spyHistory();
    await click('settings-remind-back');
    await hashIs('#/settings');
    expect(h.back).toHaveBeenCalledTimes(1);
    expect(h.replace).not.toHaveBeenCalled();
    await leavesSettings();
  });

  it('P4：日历二级页同样的走法（不比 HEAD 版退步）', async () => {
    mount();
    await click('settings-cal-entry');
    await hashIs('#/settings/calendar');
    await swipeBack('#/settings');
    await forward('#/settings/calendar');
    const h = spyHistory();
    await click('settings-cal-back');
    await hashIs('#/settings');
    expect(h.back).toHaveBeenCalledTimes(1);
    expect(h.replace).not.toHaveBeenCalled();
    await leavesSettings();
  });

  it('P5（H1）：未来 7 天 → 去编辑页 → 侧滑回来（设置页重新挂载）→ 一层一层返回 → 首页再退一步离开设置', async () => {
    mount();
    await click('settings-remind-entry');
    await click('remind-open-upcoming');
    await hashIs('#/settings/remind/upcoming');
    // 点一条去编辑页：设置页卸载
    cleanup();
    window.history.pushState({ lemoDepth: 4 }, '', '#/event/x');
    await swipeBack('#/settings/remind/upcoming');
    mount();
    const h = spyHistory();
    await click('settings-remind-up-back');
    await hashIs('#/settings/remind');
    await click('settings-remind-back');
    await hashIs('#/settings');
    expect(h.back).toHaveBeenCalledTimes(2);
    expect(h.replace).not.toHaveBeenCalled();
    await leavesSettings();
  });

  it('刷新以后：点进提醒、刷新（重新挂载，history.state 还在），点返回仍退一步', async () => {
    mount();
    await click('settings-remind-entry');
    await hashIs('#/settings/remind');
    cleanup();
    mount();
    const h = spyHistory();
    await click('settings-remind-back');
    await hashIs('#/settings');
    expect(h.back).toHaveBeenCalledTimes(1);
    expect(h.replace).not.toHaveBeenCalled();
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
  ])('点 %s 进去，%s 回来', async (entry, back) => {
    mount();
    await click(entry);
    await click(back);
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
    expect(focus.mock.calls[i]?.[0]).toEqual({ preventScroll: true });
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

  it('三层页回提醒二级页：焦点回到“未来 7 天的提醒”那一行；侧滑回来也一样', async () => {
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
