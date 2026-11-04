// 浮层（Radix Popover，R-101 年月选择器用）：非模态，不带 react-remove-scroll；定位由 floating-ui 经 CSSOM 写，CSP 下可用
// • 可以不受控（只给 trigger、children），也可以受控（open、onOpenChange：选完要收起的场合，如年月选择器）
// • Esc、点外面收起，收起后焦点回到触发按钮（Radix 自带）；触发按钮自动带 aria-expanded、aria-controls、aria-haspopup
// • 进场用 <Appear kind="popover">（架构 5.12 第 3 点）；收起直接卸载、不播退出动画（Content 不 forceMount，定位才稳）
// • onOpenAutoFocus：打开时焦点放哪（不给就放到浮层里第一个能聚焦的）
import * as RP from '@radix-ui/react-popover';
import type { ReactNode } from 'react';
import { Appear } from '../../motion/components.ts';
import styles from './Popover.module.css';

export interface PopoverProps {
  trigger: ReactNode;
  children: ReactNode;
  label: string;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  /** 加在内容上的样式类（宽度等） */
  className?: string | undefined;
  align?: 'start' | 'center' | 'end';
  onOpenAutoFocus?(e: Event): void;
  'data-testid'?: string;
}

export function Popover({ trigger, children, label, open, onOpenChange, className, align, onOpenAutoFocus, 'data-testid': testId }: PopoverProps) {
  const ctl = open === undefined ? {} : { open, onOpenChange: onOpenChange ?? (() => undefined) };
  return (
    <RP.Root {...ctl}>
      <RP.Trigger asChild>{trigger}</RP.Trigger>
      <RP.Portal>
        <RP.Content
          className={className ? `${styles.content} ${className}` : styles.content}
          aria-label={label}
          sideOffset={6}
          collisionPadding={16}
          {...(align ? { align } : {})}
          {...(onOpenAutoFocus ? { onOpenAutoFocus } : {})}
          {...(testId ? { 'data-testid': testId } : {})}
        >
          <Appear kind="popover" show>
            {children}
          </Appear>
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );
}
