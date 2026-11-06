// 设置 › 电脑 › 快速记录热键（R-297）：只在 exe 显示；没注册上提示“热键被占用”；录新热键；四种失败的提示；恢复默认；空格按语言显示。另含 设置 › 关于 的农历出处（R-306）
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type { HotkeySetResult, HotkeyStatus } from '../../../platform/desktop-hotkey.ts';
import { useQuickAddHotkey, type HotkeyApi } from '../hooks/useQuickAddHotkey.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import { DesktopSection } from '../ui/DesktopSection.tsx';
import { renderPage } from './fakes.tsx';

const DEF = 'Ctrl+Shift+Space';
const st = (accelerator = DEF, registered = true): HotkeyStatus => ({ accelerator, defaultAccelerator: DEF, registered });

function fakeHotkey(first: HotkeyStatus | null, results: HotkeySetResult[] = []) {
  let cur = first;
  const set = vi.fn(async (a: string): Promise<HotkeySetResult> => {
    const r = results.shift() ?? { ok: true, status: st(a) };
    if (r.ok) cur = r.status;
    return r;
  });
  const api: HotkeyApi = { get: vi.fn(async () => cur), set };
  return { api, set, setCur: (s: HotkeyStatus) => (cur = s) };
}

function Harness({ api }: { api: HotkeyApi }) {
  return <DesktopSection hotkey={useQuickAddHotkey(api)} />;
}

const key = (code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({ code, ...mods });

async function show(api: HotkeyApi) {
  render(<Harness api={api} />);
  await screen.findByTestId('settings-hotkey-current');
}

async function record(code: string, mods: Parameters<typeof key>[1]) {
  fireEvent.click(screen.getByTestId('settings-hotkey-change'));
  const rec = await screen.findByTestId('settings-hotkey-recorder');
  expect(document.activeElement).toBe(rec);
  await act(async () => {
    fireEvent.keyDown(rec, key(code, mods));
  });
}

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
});
afterEach(cleanup);

describe('快速记录热键（R-297）', () => {
  it('不在 exe 里（getQuickAddHotkey 回 null）：整组不显示；设置页默认（jsdom 没有 Tauri）也没有“电脑”这一组', async () => {
    const { api } = fakeHotkey(null);
    const { container } = render(<Harness api={api} />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container.childElementCount).toBe(0);
    cleanup();
    await renderPage();
    expect(document.querySelector('[data-row-id="desktop"]')).toBeNull();
    expect(screen.queryByTestId('settings-desktop-entry')).toBeNull();
  });

  it('显示现在的热键，空格按界面语言写；默认时“恢复默认”不可点', async () => {
    const { api } = fakeHotkey(st());
    await show(api);
    expect(screen.getByTestId('settings-hotkey-current').textContent).toBe(`Ctrl + Shift + ${zh['settings.hotkey.space']}`);
    expect(screen.getByTestId('settings-hotkey-reset').hasAttribute('disabled')).toBe(true);
    expect(screen.queryByTestId('settings-hotkey-unregistered')).toBeNull();
    cleanup();
    act(() => uiStore.getState().setLocale('ko-KR'));
    await show(fakeHotkey(st()).api);
    expect(screen.getByTestId('settings-hotkey-current').textContent).toBe(`Ctrl + Shift + ${ko['settings.hotkey.space']}`);
  });

  it('registered === false：常驻“热键被占用”', async () => {
    await show(fakeHotkey(st(DEF, false)).api);
    expect(screen.getByTestId('settings-hotkey-unregistered').textContent).toBe(zh['settings.hotkey.unregistered']);
  });

  it('录新热键：只按修饰键继续等；不能用的组合提示一句；按对了调 setQuickAddHotkey 并显示新的', async () => {
    const { api, set } = fakeHotkey(st());
    await show(api);
    await record('ShiftLeft', { shiftKey: true });
    expect(screen.getByTestId('settings-hotkey-recorder')).toBeTruthy();
    expect(screen.queryByTestId('settings-hotkey-notice')).toBeNull();
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('settings-hotkey-recorder'), key('KeyK', { shiftKey: true }));
    });
    expect(screen.getByTestId('settings-hotkey-notice').getAttribute('data-notice')).toBe('combo');
    expect(set).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('settings-hotkey-recorder'), key('KeyK', { ctrlKey: true, altKey: true }));
    });
    expect(set).toHaveBeenCalledWith('Ctrl+Alt+K');
    expect(screen.getByTestId('settings-hotkey-current').textContent).toBe('Ctrl + Alt + K');
    expect(screen.queryByTestId('settings-hotkey-notice')).toBeNull();
    expect(screen.getByTestId('settings-hotkey-reset').hasAttribute('disabled')).toBe(false);
  });

  it('Esc 取消、移开焦点取消，都不调 Rust', async () => {
    const { api, set } = fakeHotkey(st());
    await show(api);
    await record('Escape', {});
    expect(screen.queryByTestId('settings-hotkey-recorder')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-hotkey-change'));
    fireEvent.blur(await screen.findByTestId('settings-hotkey-recorder'));
    expect(screen.queryByTestId('settings-hotkey-recorder')).toBeNull();
    expect(set).not.toHaveBeenCalled();
  });

  it.each([
    ['in_use', 'settings.hotkey.err.inUse'],
    ['invalid', 'settings.hotkey.err.invalid'],
    ['failed', 'settings.hotkey.err.failed'],
  ] as const)('改失败 %s：给对应提示，热键还显示原来的', async (error, k) => {
    const { api } = fakeHotkey(st(), [{ ok: false, error }]);
    await show(api);
    await record('KeyJ', { ctrlKey: true, altKey: true });
    const n = screen.getByTestId('settings-hotkey-notice');
    expect(n.textContent).toBe(zh[k]);
    expect(n.getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('settings-hotkey-current').textContent).toBe(`Ctrl + Shift + ${zh['settings.hotkey.space']}`);
  });

  it('save_failed：提示没保存下来，显示 Rust 那边现在生效的新热键', async () => {
    const fake = fakeHotkey(st(), [{ ok: false, error: 'save_failed' }]);
    fake.set.mockImplementationOnce(async (a: string) => {
      fake.setCur(st(a));
      return { ok: false, error: 'save_failed' };
    });
    await show(fake.api);
    await record('KeyJ', { ctrlKey: true, altKey: true });
    expect(screen.getByTestId('settings-hotkey-notice').textContent).toBe(zh['settings.hotkey.err.saveFailed']);
    await waitFor(() => expect(screen.getByTestId('settings-hotkey-current').textContent).toBe('Ctrl + Alt + J'));
  });

  it('恢复默认：传 status.defaultAccelerator', async () => {
    const { api, set } = fakeHotkey(st('Ctrl+Alt+K'));
    await show(api);
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-hotkey-reset'));
    });
    expect(set).toHaveBeenCalledWith(DEF);
    expect(screen.getByTestId('settings-hotkey-reset').hasAttribute('disabled')).toBe(true);
  });

  it('没注册上（registered === false）时录到和现在一样的热键：照样调 hotkey_set，让用户原样重试', async () => {
    const { api, set } = fakeHotkey(st(DEF, false));
    await show(api);
    await record('Space', { ctrlKey: true, shiftKey: true });
    expect(set).toHaveBeenCalledWith(DEF);
  });

  it('只用 Ctrl 一个修饰键（新规则）：提示要再加一个修饰键，不调 Rust', async () => {
    const { api, set } = fakeHotkey(st());
    await show(api);
    await record('KeyK', { ctrlKey: true });
    expect(screen.getByTestId('settings-hotkey-notice').textContent).toBe(zh['settings.hotkey.err.combo']);
    expect(set).not.toHaveBeenCalled();
  });
});

describe('设置 › 关于（R-306）', () => {
  it('“关于”一行排在首页最后；点进二级页注明农历及节气数据出处', async () => {
    await renderPage();
    const slots = [...document.querySelectorAll('[data-row-id]')].map((n) => n.getAttribute('data-row-id'));
    expect(slots.at(-1)).toBe('about');
    expect(screen.queryByTestId('settings-lunar-credit')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-about-entry'));
    });
    expect((await screen.findByTestId('settings-lunar-credit')).textContent).toBe(zh['settings.about.lunarCredit']);
  });

  it('首页“关于”一行的值是版本号；二级页卡片里一行“版本 4.0.0”（不能点），农历出处在卡片下面（设计评审 M-1）', async () => {
    await renderPage();
    expect(screen.getByTestId('settings-about-summary').textContent).toBe('4.0.0');
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-about-entry'));
    });
    const row = await screen.findByTestId('settings-about-version');
    expect(row.textContent).toBe(`${zh['settings.about.version']}4.0.0`);
    expect(row.querySelector('button, a')).toBeNull();
    const card = screen.getByTestId('settings-about-card');
    expect(card.contains(row)).toBe(true);
    const credit = screen.getByTestId('settings-lunar-credit');
    expect(card.contains(credit)).toBe(false);
    expect(card.compareDocumentPosition(credit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
