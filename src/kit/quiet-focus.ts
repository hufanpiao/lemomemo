// 程序放焦点时分辨上一次操作是手指 / 鼠标还是键盘（全 app 只有这一份）：
// iOS Safari 把程序放的焦点也算 :focus-visible，手指点完返回、关掉弹层以后，焦点还回去的那个按钮会套一圈焦点框。
// 焦点照放（读屏接着读）；上一次是手指 / 鼠标时元素带 data-quiet-focus，base.css 的 [data-quiet-focus]:focus-visible 不画框，失焦就摘掉；
// 上一次是键盘（Tab、回车、Esc）照旧画框。用的地方：设置页退回时放回入口那一行（SettingsSub.tsx）、层栈关上还焦点（hooks/useLayer.ts 的 giveBack、kit Dialog 的 settle）

/** 上一次操作是手指 / 鼠标（不是键盘）；模块下载前的操作认不出，按手指算 */
let byPointer = true;
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => (byPointer = true), { capture: true, passive: true });
  document.addEventListener('keydown', () => (byPointer = false), { capture: true, passive: true });
}

/** 聚焦 el；上一次是手指 / 鼠标时不画焦点框 */
export function quietFocus(el: HTMLElement, preventScroll = false): void {
  if (byPointer && !el.hasAttribute('data-quiet-focus')) {
    el.setAttribute('data-quiet-focus', '');
    el.addEventListener('blur', () => el.removeAttribute('data-quiet-focus'), { once: true });
  }
  el.focus({ preventScroll, ...(byPointer ? { focusVisible: false } : {}) } as FocusOptions);
}
