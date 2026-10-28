// 弹层（Radix Dialog，架构 2.0）：焦点锁定、Esc 关闭、读屏标注用 Radix；外观全由皮肤变量决定
// CSP 结论（B0 验证，docs/07-开发日志/B0-验证-CSP下Radix与Motion.md）：
//   Radix 的 Dialog.Overlay 里带 react-remove-scroll，会插内联 <style>，被 style-src 'self' 拦。
//   所以这里不用 Dialog.Overlay，遮罩自己画，滚动锁自己写（<html class="scroll-locked">，架构 2.0 做法 ①）
import * as RD from '@radix-ui/react-dialog';
import { useEffect, type ReactNode } from 'react';
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
      <RD.Portal>
        {open ? <div className={styles.scrim} data-state="open" aria-hidden="true" /> : null}
        <RD.Content className={styles.content} aria-describedby={description === undefined ? undefined : 'dlg-desc'}>
          <RD.Title className={styles.title}>{title}</RD.Title>
          {description === undefined ? null : (
            <RD.Description id="dlg-desc" className={styles.desc}>
              {description}
            </RD.Description>
          )}
          {children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

export const DialogClose = RD.Close;
