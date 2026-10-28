// 浮层（Radix Popover，R-101 年月选择器用）：非模态，不带 react-remove-scroll；定位由 floating-ui 经 CSSOM 写，CSP 下可用
import * as RP from '@radix-ui/react-popover';
import type { ReactNode } from 'react';
import styles from './Popover.module.css';

export interface PopoverProps {
  trigger: ReactNode;
  children: ReactNode;
  label: string;
}

export function Popover({ trigger, children, label }: PopoverProps) {
  return (
    <RP.Root>
      <RP.Trigger asChild>{trigger}</RP.Trigger>
      <RP.Portal>
        <RP.Content className={styles.content} aria-label={label} sideOffset={6}>
          {children}
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );
}
