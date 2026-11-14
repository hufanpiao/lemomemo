// 浮层（Radix Popover，R-101 年月选择器用）：非模态，不带 react-remove-scroll；定位由 floating-ui 经 CSSOM 写，CSP 下可用
// • 可以不受控（只给 trigger、children），也可以受控（open、onOpenChange：选完要收起的场合，如年月选择器）
// • 开着时是层栈（kit/hooks/layers.ts）里的一层（非模态）：Esc 只在它是栈顶时收起（不会连着外面的弹层、抽屉一起关）；
//   点外面收起、收起后焦点回到触发按钮照旧是 Radix 自带（层栈不另还）；触发按钮自动带 aria-expanded、aria-controls、aria-haspopup
// • 不受控时开关也记在这里（层栈要知道开没开、Esc 要能收起它）
// • 进场用 <Appear kind="popover">（架构 5.12 第 3 点）；收起直接卸载、不播退出动画（Content 不 forceMount，定位才稳）
// • onOpenAutoFocus：打开时焦点放哪（不给就放到浮层里第一个能聚焦的）
import * as RP from '@radix-ui/react-popover';
import { useRef, useState, type ReactNode } from 'react';
import { Appear } from '../../motion/components.ts';
import { useLayer } from '../hooks/useLayer.ts';
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
  const [own, setOwn] = useState(false);
  const shown = open ?? own;
  const set = (o: boolean): void => {
    if (open === undefined) setOwn(o);
    onOpenChange?.(o);
  };
  const box = useRef<HTMLDivElement>(null);
  useLayer(shown, { name: 'popover', el: () => box.current?.closest('body > *') ?? null, onEsc: () => set(false), back: () => [] });
  return (
    <RP.Root open={shown} onOpenChange={set}>
      <RP.Trigger asChild>{trigger}</RP.Trigger>
      <RP.Portal>
        <RP.Content
          ref={box}
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
