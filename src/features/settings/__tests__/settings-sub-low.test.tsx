// 设置子页的低问题（提醒接线代码复审第二轮 N1、N2）：
// N1 直接打开提醒二级页 → 未来 7 天 → 侧滑 → “‹ 设置” → 前进 → “‹ 提醒与通知”，要回到二级页（不跳到首页、不叠历史）；
// N2 焦点放回入口：入口晚出来要接着找（R6），等的时候用户已经把焦点挪走就不抢回来；三层页之间直接换要重新挂载（R14，key）。
// 提醒二级页的正文换成“晚 200 ms 才出来”的包装（真组件照常渲染），模拟懒加载慢的时候
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState, type ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { fakeApi, fakeExit, now } from './fakes.tsx';

vi.setConfig({ testTimeout: 15_000 });

const slow = { on: false };
vi.mock('../../reminders/index.ts', async (orig) => {
  // 只拿原模块当普通对象（设置的测试不 import reminders，功能边界）
  const real = await orig<Record<string, unknown>>();
  const Real = real['RemindSettings'] as ComponentType<Record<string, unknown>>;
  function SlowRemindSettings(props: Record<string, unknown>) {
    const [show, setShow] = useState(!slow.on);
    useEffect(() => {
      if (show) return;
      const t = setTimeout(() => setShow(true), 200);
      return () => clearTimeout(t);
    }, [show]);
    return show ? <Real {...props} /> : null;
  }
  return { ...real, RemindSettings: SlowRemindSettings };
});

const { default: SettingsPage } = await import('../ui/SettingsPage.tsx');

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  localStorage.clear();
  slow.on = false;
  window.history.replaceState(null, '', '#/today');
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
const move = async (fn: () => void, to: string): Promise<void> => {
  await act(async () => {
    fn();
  });
  await hashIs(to);
};

describe('N1：上一条被换掉以后点返回不跳层', () => {
  it('直接打开二级页 → 未来 7 天 → 侧滑 → “‹ 设置” → 前进 → “‹ 提醒与通知”：回到二级页，再返回是首页，再侧滑离开设置', async () => {
    window.history.pushState({ lemoDepth: 1 }, '', '#/settings/remind');
    mount();
    await click('remind-open-upcoming');
    await hashIs('#/settings/remind/upcoming');
    await move(() => window.history.back(), '#/settings/remind');
    await click('settings-remind-back');
    await hashIs('#/settings');
    await move(() => window.history.forward(), '#/settings/remind/upcoming');
    const push = vi.spyOn(window.history, 'pushState');
    await click('settings-remind-up-back');
    await hashIs('#/settings/remind');
    expect(await screen.findByTestId('settings-remind-back', {}, { timeout: 10_000 })).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
    await click('settings-remind-back');
    await hashIs('#/settings');
    // 历史里没有叠出两条“设置”：再侧滑一下就离开设置
    await move(() => window.history.back(), '#/today');
  });
});

describe('N2：焦点放回入口', () => {
  it('入口晚出来（约 200 ms）：接着找，出来以后焦点放到“未来 7 天的提醒”那一行（R6）', async () => {
    window.history.pushState({ lemoDepth: 1 }, '', '#/settings');
    mount();
    await click('settings-remind-entry');
    await click('remind-open-upcoming');
    await hashIs('#/settings/remind/upcoming');
    slow.on = true;
    await click('settings-remind-up-back');
    await hashIs('#/settings/remind');
    const entry = await screen.findByTestId('remind-open-upcoming', {}, { timeout: 10_000 });
    await waitFor(() => expect(document.activeElement).toBe(entry), { timeout: 3000 });
  });

  it('等入口的时候用户已经把焦点挪到“‹ 设置”上：入口出来也不抢回来', async () => {
    window.history.pushState({ lemoDepth: 1 }, '', '#/settings');
    mount();
    await click('settings-remind-entry');
    await click('remind-open-upcoming');
    await hashIs('#/settings/remind/upcoming');
    slow.on = true;
    await click('settings-remind-up-back');
    await hashIs('#/settings/remind');
    const backBtn = await screen.findByTestId('settings-remind-back', {}, { timeout: 10_000 });
    act(() => backBtn.focus());
    await screen.findByTestId('remind-open-upcoming', {}, { timeout: 10_000 });
    // 重试最多约 1 秒：等过这段再看
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200));
    });
    expect(document.activeElement).toBe(backBtn);
  });

  it('三层页之间直接换（改地址）：整页重新挂载，焦点放到新页的标题上（R14）', async () => {
    window.history.pushState({ lemoDepth: 1 }, '', '#/settings/remind/show-title');
    mount();
    await screen.findByTestId('settings-remind-show-title', {}, { timeout: 10_000 });
    const oldBack = screen.getByTestId('settings-remind-st-back');
    act(() => oldBack.focus());
    await act(async () => {
      window.history.replaceState({ lemoDepth: 1 }, '', '#/settings/remind/dnd');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await screen.findByTestId('settings-remind-dnd', {}, { timeout: 10_000 });
    await waitFor(() => expect(document.activeElement?.tagName).toBe('H1'));
    expect(document.activeElement?.textContent).toBe('免打扰');
  });
});
