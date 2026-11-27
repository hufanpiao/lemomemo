// desktop-hotkey.ts（R-297 快速记录热键）：读状态、改热键的错误码折算、键盘事件换成热键写法。Rust 命令用假的
import { describe, expect, it } from 'vitest';
import { getQuickAddHotkey, hotkeyFromKeyboardEvent, hotkeyLabel, setQuickAddHotkey, toHotkeyStatus } from '../desktop-hotkey.ts';

const STATUS = { accelerator: 'Ctrl+Shift+Space', defaultAccelerator: 'Ctrl+Shift+Space', registered: true };

describe('读、改快速记录热键', () => {
  it('hotkey_get：形状对就原样给；不在 exe 里、出错、形状不对都返回 null', async () => {
    const calls: string[] = [];
    expect(await getQuickAddHotkey(async (cmd) => (calls.push(cmd), STATUS))).toEqual(STATUS);
    expect(calls).toEqual(['hotkey_get']);
    expect(await getQuickAddHotkey(undefined)).toBeNull();
    expect(await getQuickAddHotkey(() => Promise.reject('boom'))).toBeNull();
    expect(await getQuickAddHotkey(async () => ({ accelerator: 'x' }))).toBeNull();
    expect(toHotkeyStatus({ ...STATUS, registered: 'yes' })).toBeNull();
    expect(toHotkeyStatus({ ...STATUS, registered: false })).toEqual({ ...STATUS, registered: false });
  });

  it('hotkey_set：参数是 { accelerator }，成功给新状态', async () => {
    let seen: unknown;
    const next = { ...STATUS, accelerator: 'Ctrl+Alt+K' };
    const r = await setQuickAddHotkey('Ctrl+Alt+K', async (cmd, args) => ((seen = [cmd, args]), next));
    expect(seen).toEqual(['hotkey_set', { accelerator: 'Ctrl+Alt+K' }]);
    expect(r).toEqual({ ok: true, status: next });
  });

  it.each([
    ['hotkey_invalid', 'invalid'],
    ['hotkey_in_use', 'in_use'],
    ['hotkey_save_failed', 'save_failed'],
    ['require_window', 'failed'],
  ])('Rust 返回 %s → %s', async (code, error) => {
    expect(await setQuickAddHotkey('Ctrl+Alt+K', () => Promise.reject(code))).toEqual({ ok: false, error });
  });

  it('不在 exe 里、回了认不出的东西都算 failed', async () => {
    expect(await setQuickAddHotkey('Ctrl+Alt+K', undefined)).toEqual({ ok: false, error: 'failed' });
    expect(await setQuickAddHotkey('Ctrl+Alt+K', async () => 42)).toEqual({ ok: false, error: 'failed' });
  });
});

describe('键盘事件换成热键写法（和 Rust hotkey::parse 规整后的一样）', () => {
  const ev = (code: string, m: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) => ({
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...m,
  });

  it('修饰键按 Ctrl+Alt+Shift+Win 的顺序，按物理键位认键', () => {
    expect(hotkeyFromKeyboardEvent(ev('Space', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+Space');
    expect(hotkeyFromKeyboardEvent(ev('KeyK', { altKey: true, ctrlKey: true }))).toBe('Ctrl+Alt+K');
    expect(hotkeyFromKeyboardEvent(ev('Digit7', { metaKey: true, shiftKey: true }))).toBe('Shift+Win+7');
    expect(hotkeyFromKeyboardEvent(ev('F12', { metaKey: true }))).toBe('Win+F12');
  });

  it('只有 Shift、没有修饰键、只按了修饰键、键不在名单里都返回 null', () => {
    expect(hotkeyFromKeyboardEvent(ev('KeyK', { shiftKey: true }))).toBeNull();
    expect(hotkeyFromKeyboardEvent(ev('KeyK'))).toBeNull();
    expect(hotkeyFromKeyboardEvent(ev('ControlLeft', { ctrlKey: true }))).toBeNull();
    for (const code of ['Enter', 'F13', 'F0', 'Numpad1', 'Backquote', 'Keyk']) {
      expect(hotkeyFromKeyboardEvent(ev(code, { ctrlKey: true })), code).toBeNull();
    }
  });

  it('只有 Ctrl 或只有 Alt 一个修饰键的系统常用键返回 null（安全审查 B-2）；再带 Shift、Win 或另一个修饰键的可以', () => {
    for (const code of ['KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyA', 'KeyS', 'KeyW', 'F4', 'Space', 'KeyK']) {
      expect(hotkeyFromKeyboardEvent(ev(code, { ctrlKey: true })), `Ctrl ${code}`).toBeNull();
      expect(hotkeyFromKeyboardEvent(ev(code, { altKey: true })), `Alt ${code}`).toBeNull();
    }
    expect(hotkeyFromKeyboardEvent(ev('KeyC', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+C');
    expect(hotkeyFromKeyboardEvent(ev('KeyV', { ctrlKey: true, metaKey: true }))).toBe('Ctrl+Win+V');
    expect(hotkeyFromKeyboardEvent(ev('F4', { altKey: true, shiftKey: true }))).toBe('Alt+Shift+F4');
    expect(hotkeyFromKeyboardEvent(ev('KeyZ', { ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+Z');
    // Win+Space 是切换输入法的系统热键，不收；再带别的修饰键可以
    expect(hotkeyFromKeyboardEvent(ev('Space', { metaKey: true }))).toBeNull();
    expect(hotkeyFromKeyboardEvent(ev('Space', { ctrlKey: true, metaKey: true }))).toBe('Ctrl+Win+Space');
    expect(hotkeyFromKeyboardEvent(ev('F12', { metaKey: true }))).toBe('Win+F12');
  });

  it('显示用：Space 换成“空格”，加号两边留空', () => {
    expect(hotkeyLabel('Ctrl+Shift+Space', '空格')).toBe('Ctrl + Shift + 空格');
    expect(hotkeyLabel('Ctrl+Shift+Space', '스페이스')).toBe('Ctrl + Shift + 스페이스');
    expect(hotkeyLabel('Ctrl+Alt+K', '空格')).toBe('Ctrl + Alt + K');
  });
});
