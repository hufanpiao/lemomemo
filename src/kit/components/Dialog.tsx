// 弹层（Radix Dialog，架构 2.0）：焦点锁定、Esc 关闭、读屏标注用 Radix；外观全由皮肤变量决定
// CSP 结论（B0 验证，docs/07-开发日志/B0-验证-CSP下Radix与Motion.md）：
//   Radix 的 Dialog.Overlay 里带 react-remove-scroll，会插内联 <style>，被 style-src 'self' 拦。
//   所以这里不用 Dialog.Overlay，遮罩自己画，滚动锁自己写（<html class="scroll-locked">，架构 2.0 做法 ①）
// 进出场（17.1“弹层的遮罩和内容”、17.4 B2；UI-4 L-2、接手清单 M4）：按 17.1 的第一种写法——
//   Portal 和 Content 都 forceMount，挂载和卸载交给 <Appear>（AnimatePresence 等退出动画播完才卸载）：
//   内容 kind="sheet" 从底部滑入、原路滑回（--dur-sheet + --ease-drawer），遮罩 kind="scrim" 淡入淡出（--dur-ui + --ease-out）；
//   减少动态效果时 Appear 只淡入淡出、时长减半（遮罩也减半）。
//   关闭途中 Appear 打 data-state="leaving"，这时两层都不接点按（Dialog.module.css），不挡后面的页面、不会误点正在滑走的按钮。
//   不用 data-state + @keyframes：同一个类名上进、出两段动位移的动画，lemo/reduced-motion-override 认不出覆盖（B2 试过）
// 关掉以后焦点还给打开前的元素（FA-6 ② 审查 L4，主持人 11-04 定）：Radix 的 modal Content 关闭时会拦掉 FocusScope 自己的“还回去”，
//   改成 triggerRef.current?.focus()；使用方都是自己的按钮 setOpen(true)、不用 RD.Trigger，triggerRef 是空的，焦点就一直停在 body。
//   所以这里在打开的那一刻（useLayoutEffect，早于 FocusScope 在 useEffect 里把焦点移进弹层）记下 document.activeElement，
//   onCloseAutoFocus 里先 preventDefault（Radix 就不再去找 triggerRef），再还给记下的元素——它还在文档里、没被禁用才还
import * as RD from '@radix-ui/react-dialog';
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Appear } from '../../motion/components.ts';
import styles from './Dialog.module.css';

/** 打开时给 <html> 加 scroll-locked（样式在 styles/base.css）；支持多层弹层叠加 */
let lockCount = 0;
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    lockCount += 1;
    document.documentElement.classList.add('scroll-locked');
    return () => {
      lockCount -= 1;
      if (lockCount === 0) document.documentElement.classList.remove('scroll-locked');
    };
  }, [active]);
}

export interface DialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: string;
  children?: ReactNode;
}

/** 能不能把焦点还给它：还在文档里，没被禁用 */
function canRefocus(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement) || !el.isConnected || el === document.body) return false;
  return !(el as HTMLElement & { disabled?: boolean }).disabled;
}

export function Dialog({ open, onOpenChange, title, description, children }: DialogProps) {
  useScrollLock(open);
  const returnTo = useRef<Element | null>(null);
  useLayoutEffect(() => {
    if (open) returnTo.current = document.activeElement;
  }, [open]);
  const restoreFocus = (e: Event): void => {
    e.preventDefault();
    const el = returnTo.current;
    returnTo.current = null;
    if (canRefocus(el)) el.focus();
  };
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal forceMount>
        <Appear kind="scrim" show={open} className={styles.scrim}>
          {null}
        </Appear>
        <Appear kind="sheet" show={open} className={styles.dock}>
          {/* 描述的 id 和 aria-describedby 都交给 Radix 管（每个弹层各生成一个，不重名）：有描述时什么都不传；
              没描述时显式传 undefined，Radix 就不写 aria-describedby，也不报缺描述的警告 */}
          <RD.Content forceMount className={styles.content} onCloseAutoFocus={restoreFocus} {...(description === undefined ? { 'aria-describedby': undefined } : {})}>
            <RD.Title className={styles.title}>{title}</RD.Title>
            {description === undefined ? null : (
              <RD.Description className={styles.desc}>{description}</RD.Description>
            )}
            {children}
          </RD.Content>
        </Appear>
      </RD.Portal>
    </RD.Root>
  );
}

export const DialogClose = RD.Close;
