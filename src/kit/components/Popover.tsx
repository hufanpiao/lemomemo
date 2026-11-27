// 浮层（Radix Popover）：非模态，不带 react-remove-scroll；定位由 floating-ui 经 CSSOM 写，CSP 下可用
// • 可以不受控（只给 trigger、children），也可以受控（open、onOpenChange：选完要收起的场合，如年月选择器）
// • 开着时是层栈（kit/hooks/layers.ts）里的一层（非模态）：Esc 只在它是栈顶时收起（不会连着外面的弹层、抽屉一起关）；
//   点外面收起是 Radix 自带，收起后焦点回到触发按钮由这里做（层栈不另还）；触发按钮自动带 aria-expanded、aria-controls、aria-haspopup（第一次打开才挂 Radix，见函数里）
// • 不受控时开关也记在这里（层栈要知道开没开、Esc 要能收起它）
// • 进场用 <Appear kind="popover">；收起直接卸载、不播退出动画（Content 不 forceMount，定位才稳）
// • onOpenAutoFocus：打开时焦点放哪（不给就放到浮层里第一个能聚焦的）
import * as RP from '@radix-ui/react-popover';
import { cloneElement, isValidElement, useCallback, useId, useRef, useState, type MouseEvent, type ReactNode, type Ref } from 'react';
import { Appear } from '../../motion/components.ts';
import { useLayer } from '../hooks/useLayer.ts';
import styles from './Popover.module.css';

/** 触发按钮上 Popover 会补、会接的几样（原来 Radix Trigger 补的那些） */
interface TriggerProps {
  ref?: Ref<HTMLElement> | undefined;
  type?: string;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  'aria-haspopup'?: string;
  'aria-expanded'?: boolean;
  'aria-controls'?: string | undefined;
  'data-state'?: string;
}

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
  useLayer(shown, { name: 'popover', el: () => box.current, onEsc: () => set(false), back: () => [] });
  // 用到才挂（随手记 200 条每条“⋯”，常驻 Radix 时收着也是一套 13 个组件）：
  // 触发按钮一直由这里画、位置不变（DOM 节点从头到尾是同一个，焦点、外面拿着的引用都不丢）；第一次打开（点一下或页面直接给 open）才在旁边挂上 Radix，
  // 浮层经 Anchor 的 virtualRef 对准这颗按钮，挂上以后一直留着。原来 Radix Trigger 做的几样照原样在这里做：
  // 补 type=button、aria-haspopup、aria-expanded、开着时的 aria-controls、data-state（按钮自己写了的以按钮为准，同 Radix Slot）；点一下先走按钮自己的 onClick，没 preventDefault 才开关；
  // 开着时按在这颗按钮上不算“点外面”（由按钮的 click 收起）；收起时没点过外面就把焦点还给按钮（同 Radix 非模态浮层）
  const [used, setUsed] = useState(shown);
  if (shown && !used) setUsed(true);
  const contentId = useId();
  const btn = useRef<HTMLElement | null>(null);
  /** 这次打开以后点过外面没有：点过就不抢焦点回按钮 */
  const outside = useRef(false);
  // 按钮自己带的 ref（对象 ref、回调 ref 都认）由 setBtn 转过去。setBtn 是同一个函数，React 只在挂上（给节点）、卸下（给 null）时调它：
  // 挂上以后按钮换成另一个 ref 不会再转给新的那个；回调 ref 返回的清理函数（React 19 写法）不认，卸下时照旧调 ref(null)。现在用到的几处都是不变的 ref
  const theirRef = useRef<Ref<HTMLElement> | undefined>(undefined);
  const el = isValidElement<TriggerProps>(trigger) ? trigger : null;
  theirRef.current = el?.props.ref;
  const setBtn = useCallback((node: HTMLElement | null): void => {
    btn.current = node;
    const r = theirRef.current;
    if (typeof r === 'function') r(node);
    else if (r) r.current = node;
  }, []);
  const prev = el?.props.onClick;
  const button = el
    ? cloneElement(el, {
        type: 'button',
        'aria-haspopup': 'dialog',
        'aria-expanded': shown,
        'aria-controls': shown ? contentId : undefined,
        'data-state': shown ? 'open' : 'closed',
        ...el.props,
        ref: setBtn,
        onClick: (e: MouseEvent<HTMLElement>) => {
          prev?.(e);
          if (!e.defaultPrevented) set(!shown);
        },
      })
    : trigger;
  return (
    <>
      {button}
      {used ? (
        <RP.Root open={shown} onOpenChange={set}>
          <RP.Anchor virtualRef={btn} />
          <RP.Portal>
            <RP.Content
              ref={box}
              id={contentId}
              className={className ? `${styles.content} ${className}` : styles.content}
              aria-label={label}
              sideOffset={6}
              collisionPadding={16}
              {...(align ? { align } : {})}
              {...(onOpenAutoFocus ? { onOpenAutoFocus } : {})}
              {...(testId ? { 'data-testid': testId } : {})}
              onInteractOutside={(e) => {
                outside.current = true;
                const t = e.target;
                if (t instanceof Node && btn.current?.contains(t)) e.preventDefault();
              }}
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                if (!outside.current) btn.current?.focus();
                outside.current = false;
              }}
            >
              <Appear kind="popover" show>
                {children}
              </Appear>
            </RP.Content>
          </RP.Portal>
        </RP.Root>
      ) : null}
    </>
  );
}
