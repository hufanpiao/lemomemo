// 窗口内快捷键（kit/hooks/useKeys.ts；架构 5.9；B3 S24）：
// • mod = Ctrl 或 ⌘；带 Alt、Shift+mod 的不认
// • 单字母键焦点在能打字的地方不生效（判断是 platform/env.ts 的 opensKeyboard，用例在 env-device.test.ts）；带 mod 的照常交给处理函数
// • 处理函数返回 true 才阻止默认动作；别人已经接住的、输入法组字中的不管
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyName, useKeys, type KeyMap } from '../useKeys.ts';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const press = (init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

function Keys({ map }: { map: KeyMap }) {
  useKeys(map);
  return null;
}

describe('keyName', () => {
  it('Ctrl、⌘ 都算 mod；字母不分大小写；带 Alt、Shift+mod、Ctrl+⌘ 的不认', () => {
    const k = (i: KeyboardEventInit) => keyName(new KeyboardEvent('keydown', i));
    expect(k({ key: 'n', ctrlKey: true })).toBe('mod+n');
    expect(k({ key: 'N', metaKey: true })).toBe('mod+n');
    expect(k({ key: 'j' })).toBe('j');
    expect(k({ key: 'Escape' })).toBe('Escape');
    expect(k({ key: 'z', ctrlKey: true, shiftKey: true })).toBeNull();
    expect(k({ key: 'n', ctrlKey: true, altKey: true })).toBeNull();
    expect(k({ key: 'n', ctrlKey: true, metaKey: true })).toBeNull();
  });
});

describe('useKeys', () => {
  it('接住（返回 true）才阻止默认动作；返回 false 交给浏览器', () => {
    const n = vi.fn(() => true);
    const z = vi.fn(() => false);
    render(<Keys map={{ 'mod+n': n, 'mod+z': z }} />);
    expect(press({ key: 'n', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press({ key: 'z', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(n).toHaveBeenCalledTimes(1);
    expect(z).toHaveBeenCalledTimes(1);
  });

  it('单字母键焦点在输入框里不生效；带 mod 的照常生效', () => {
    const j = vi.fn(() => true);
    const n = vi.fn(() => true);
    render(<Keys map={{ j, 'mod+n': n }} />);
    const inp = document.createElement('input');
    document.body.append(inp);
    press({ key: 'j' }, inp);
    expect(j).not.toHaveBeenCalled();
    press({ key: 'j' });
    expect(j).toHaveBeenCalledTimes(1);
    press({ key: 'n', ctrlKey: true }, inp);
    expect(n).toHaveBeenCalledTimes(1);
  });

  it('别人已经接住的、输入法组字中的不管；卸载以后不再响应', () => {
    const n = vi.fn(() => true);
    const { unmount } = render(<Keys map={{ 'mod+n': n }} />);
    const el = document.createElement('div');
    document.body.append(el);
    el.addEventListener('keydown', (e) => e.preventDefault());
    press({ key: 'n', ctrlKey: true }, el);
    press({ key: 'n', ctrlKey: true, isComposing: true });
    expect(n).not.toHaveBeenCalled();
    unmount();
    press({ key: 'n', ctrlKey: true });
    expect(n).not.toHaveBeenCalled();
  });

  it('处理函数换了以后用新的（不重挂监听）', () => {
    const a = vi.fn(() => true);
    const b = vi.fn(() => true);
    const { rerender } = render(<Keys map={{ 'mod+n': a }} />);
    rerender(<Keys map={{ 'mod+n': b }} />);
    press({ key: 'n', ctrlKey: true });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});
