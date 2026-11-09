// 窗口内快捷键（架构 5.9“窗口内快捷键”；B3 S24 先做 Ctrl+N、Ctrl+Z，其余单字母键随 B6，Ctrl+K 随 B4b-3）
// • 键名写成 'mod+n'、'mod+z'：mod = Ctrl（Windows）或 ⌘（Mac）；带 Alt、Shift 的不算（Ctrl+Shift+Z 留给重做）
// • 单字母键（没有 mod）：焦点在输入框、文本框、可编辑区域里时不生效（5.9）；带 mod 的照常生效，处理函数自己决定（例如 Ctrl+Z 在有字的输入框里让给浏览器撤销打字）
// • 处理函数返回 true 才算接住（阻止默认动作）；返回 false 照常交给浏览器
// • 别人已经接住的（defaultPrevented，例如设置里录快捷键）、输入法组字中的，一律不管
// 纯 TS，很小，进首屏
import { useEffect, useRef } from 'react';

export type KeyHandler = (e: KeyboardEvent) => boolean;
export type KeyMap = Partial<Record<string, KeyHandler>>;

/** 焦点在能打字的地方 */
export function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) {
    return !el.readOnly && !el.disabled && !/^(button|checkbox|radio|range|color|file|submit|reset|image|hidden)$/.test(el.type);
  }
  return false;
}

/** 按键 → 键名（'mod+n'、'?'、'j'）；带 Alt、Shift+mod 的返回 null */
export function keyName(e: KeyboardEvent): string | null {
  const mod = e.ctrlKey || e.metaKey;
  if (e.altKey || (e.ctrlKey && e.metaKey)) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod) return e.shiftKey ? null : `mod+${k}`;
  return k;
}

export function useKeys(map: KeyMap): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing) return;
      const name = keyName(e);
      if (name === null) return;
      const fn = ref.current[name];
      if (!fn) return;
      if (!name.startsWith('mod+') && isEditable(e.target)) return;
      if (fn(e)) e.preventDefault();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
}
