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
import * as RD from '@radix-ui/react-dialog';
import { useEffect, type ReactNode } from 'react';
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

export function Dialog({ open, onOpenChange, title, description, children }: DialogProps) {
  useScrollLock(open);
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal forceMount>
        <Appear kind="scrim" show={open} className={styles.scrim}>
          {null}
        </Appear>
        <Appear kind="sheet" show={open} className={styles.dock}>
          {/* 描述的 id 和 aria-describedby 都交给 Radix 管（每个弹层各生成一个，不重名）：有描述时什么都不传；
              没描述时显式传 undefined，Radix 就不写 aria-describedby，也不报缺描述的警告 */}
          <RD.Content forceMount className={styles.content} {...(description === undefined ? { 'aria-describedby': undefined } : {})}>
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
