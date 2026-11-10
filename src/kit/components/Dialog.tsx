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
// 还焦点的时机（MOTION-②-low 与 Dialog 焦点审查 L-1，11-05）：open 变成 false 的那一次提交里就还（useEffect：这时 Radix FocusScope
//   锁焦点的监听已经在同一次提交的清理阶段摘掉，不会把焦点拉回弹层），不等退场动画播完、Content 卸载；
//   原来要等卸载，焦点先在 body 上停 0.03～0.38 秒，这段时间按 Tab 会从页面开头走。卸载时的 onCloseAutoFocus 只 preventDefault，
//   焦点还在 body 或者还在正在退场的弹层里（例如提前还的时候打开按钮还被禁用着）才再还一次；用户已经点到别处就不动
// 读屏补报（第 1 批审查 M1，主持人 11-05 定第一种）：提前还焦点时 Content 还挂着，Radix 的 hideOthers 让页面其余部分还带着
//   aria-hidden（要等 Content 卸载才撤），焦点落在被隐藏的打开按钮上，VoiceOver 不报、撤掉以后也不补报。所以卸载时
//   （onCloseAutoFocus，Radix 在卸载后的 setTimeout 里派，这时 aria-hidden 已经撤了）焦点还停在提前还的那个元素上，
//   就 blur() 再 focus() 一次，让读屏重新报出来
// 退路（L-2）：打开按钮被禁用、被移走（确认移除以后按钮变 removing、整块返回 null 等）时还不回去，
//   使用方可以传 returnFocus 给一个退路元素（所在区块的标题、新出现的按钮），还不了打开按钮就还给它；都不行才留在 body
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
  /** 退路（审查 L-2）：打开前的元素还不回去（被禁用、被移走）时把焦点给它；返回 null 或同样还不了就算了 */
  returnFocus?: () => HTMLElement | null;
  /** 标题上面放的东西（例如图标）。B3 S23：负责人 11-10 定，麦克风说明卡按线框 s10 在卡顶加麦克风图标；目前只有 MicCard 传 */
  lead?: ReactNode;
  /** 标题、说明、内容都居中。B3 S23：负责人 11-10 定，麦克风说明卡按线框 s10 居中；目前只有 MicCard 传。不传时类名和渲染结果都和原来一样 */
  center?: boolean;
}

/** 能不能把焦点还给它：还在文档里，没被禁用 */
function canRefocus(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement) || !el.isConnected || el === document.body) return false;
  return !(el as HTMLElement & { disabled?: boolean }).disabled;
}

export function Dialog({ open, onOpenChange, title, description, children, returnFocus, lead, center }: DialogProps) {
  useScrollLock(open);
  const returnTo = useRef<Element | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const fallback = useRef(returnFocus);
  fallback.current = returnFocus;
  /** 提前还焦点（关上那一刻）时给到的元素：卸载时它还拿着焦点，就重新聚焦一次让读屏补报（M1） */
  const early = useRef<HTMLElement | null>(null);
  /** 按“打开前的元素 → 退路”的顺序还焦点；真聚焦上了（document.activeElement 就是它）才算还成，返回它（D-L4：在 inert 里、被隐藏的聚焦不上，接着试退路） */
  const giveBack = (): HTMLElement | null => {
    for (const el of [returnTo.current, fallback.current?.() ?? null]) {
      if (!canRefocus(el)) continue;
      el.focus();
      if (document.activeElement === el) return el;
    }
    return null;
  };
  useLayoutEffect(() => {
    if (open) returnTo.current = document.activeElement;
  }, [open]);
  // L-1：关上的那一次提交里就还（见文件头）；第一次挂载时 open 就是 false、没记过，不动
  useEffect(() => {
    if (open || returnTo.current === null) return;
    const active = document.activeElement;
    // 关的途中用户已经把焦点放到弹层外的别处：不抢
    if (active && active !== document.body && !content.current?.contains(active)) return;
    early.current = giveBack();
  }, [open]);
  const restoreFocus = (e: Event): void => {
    e.preventDefault();
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected || (content.current?.contains(active) ?? false);
    if (lost) giveBack();
    else if (active === early.current) {
      // M1：提前还的时候它在 aria-hidden 里，读屏没报；现在撤掉了，重新聚焦一次
      early.current.blur();
      early.current.focus();
    }
    returnTo.current = null;
    early.current = null;
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
          <RD.Content
            ref={content}
            forceMount
            className={center === true ? `${styles.content} ${styles.center}` : styles.content}
            onCloseAutoFocus={restoreFocus}
            {...(description === undefined ? { 'aria-describedby': undefined } : {})}
          >
            {lead == null ? null : <div className={styles.lead}>{lead}</div>}
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
