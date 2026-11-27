// 弹层（Radix Dialog）：焦点锁定、读屏标注用 Radix；外观全由皮肤变量决定
// CSP：Radix 的 Dialog.Overlay 里带 react-remove-scroll，会插内联 <style>，被 style-src 'self' 拦。
//   所以这里不用 Dialog.Overlay，遮罩自己画；滚动锁是层栈的（模态层开着时 <html class="scroll-locked">）
// 进出场：Portal 和 Content 都 forceMount，挂载和卸载交给 <Appear>（AnimatePresence 等退出动画播完才卸载）：
//   内容 kind="sheet" 从底部滑入、原路滑回（--dur-sheet + --ease-drawer），遮罩 kind="scrim" 淡入淡出（--dur-ui + --ease-out）；
//   减少动态效果时 Appear 只淡入淡出、时长减半（遮罩也减半）。
//   关闭途中 Appear 打 data-state="leaving"，这时两层都不接点按（Dialog.module.css），不挡后面的页面、不会误点正在滑走的按钮。
//   不用 data-state + @keyframes：同一个类名上进、出两段动位移的动画，lemo/reduced-motion-override 认不出覆盖
// Esc、inert、滚动锁、还焦点都交给层栈（kit/hooks/layers.ts）：open 时入栈（模态），Radix 只管锁焦点和读屏标注。
//   还焦点：打开那一刻记下的元素 → 退路 returnFocus；关上那一次提交里就还（层栈 passive 阶段），
//   不等退场动画播完；Radix 的 onCloseAutoFocus（Content 卸载以后）不要默认动作，补一次（settle）：焦点掉在 body 就再还一次
//   （关上时打开按钮还禁用着、退场途中恢复了），在别的元素上就重新聚焦一次让读屏补报（提前还时 Radix 的 aria-hidden 还没撤）。
//   两处都走 kit/quiet-focus.ts：手指点开、关上时还回去的按钮不画焦点框，键盘照旧画
import * as RD from '@radix-ui/react-dialog';
import { useRef, type ReactNode } from 'react';
import { Appear } from '../../motion/components.ts';
import { canFocus, giveBack, useLayer } from '../hooks/useLayer.ts';
import { quietFocus } from '../quiet-focus.ts';
import styles from './Dialog.module.css';
import mist from './Mist.module.css';

export interface DialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** 标题。不传时这里不画标题，调用方在 children 里自己放 <DialogTitle>（标题和按钮同一行的头部，今日运势弹层）；读屏照样有名字 */
  title?: string;
  description?: string;
  children?: ReactNode;
  /** 退路：打开前的元素还不回去（被禁用、被移走）时把焦点给它；返回 null 或同样还不了就算了 */
  returnFocus?: () => HTMLElement | null;
  /** 标题上面放的东西（例如图标）；目前只有 MicCard 传 */
  lead?: ReactNode;
  /** 标题、说明、内容都居中；目前只有 MicCard 传 */
  center?: boolean;
  /** 标题同一行右边放的东西（如纪念日提醒弹层的“恢复默认”） */
  aside?: ReactNode;
  /** 后面那一层：不传是浅灰遮罩；'mist' 换成输入时那层液态模糊玻璃（后面整页模糊、卡片不变；材质直接用 Mist.module.css 的 .glass，不另写一份；
      进出场照旧 <Appear>）。新分类弹窗、今日运势传 */
  backdrop?: 'mist';
  /** 贴底边的整宽弹层（最宽 430、只有上面两角圆、太高就自己滚动）；目前只有今日运势传 */
  edge?: boolean;
  /** 内容的 lang（韩文界面的弹层写 ko，读屏和断行按韩文） */
  lang?: string;
}

export function Dialog({ open, onOpenChange, title, description, children, returnFocus, lead, center, aside, backdrop, edge, lang }: DialogProps) {
  const content = useRef<HTMLDivElement>(null);
  const layer = useLayer(open, {
    name: 'dialog',
    modal: true,
    el: () => content.current,
    onEsc: () => onOpenChange(false),
    back: (opener) => [opener, returnFocus?.()],
  });
  const settle = (e: Event): void => {
    e.preventDefault();
    const a = document.activeElement;
    if (canFocus(a)) {
      a.blur();
      quietFocus(a);
    } else if (layer.layer) giveBack(layer.layer);
  };
  // 打开时焦点放哪：Radix 默认聚焦第一个能聚焦的元素，
  // 多数弹层第一个是“关闭”按钮，iPhone 上程序放的焦点也命中 :focus-visible、画出焦点框。
  // 第一个是打字的框就照旧给它（改名、搜索要直接弹键盘）；不是就放在弹层本身（tabIndex -1，base.css 不画框），读屏从弹层开头读
  const openFocus = (e: Event): void => {
    const box = content.current;
    if (!box) return;
    e.preventDefault();
    const first = box.querySelector<HTMLElement>('input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), [contenteditable="true"], button:not(:disabled), [href], select, [tabindex]:not([tabindex="-1"])');
    if (first && first.matches('input:not([type="checkbox"], [type="radio"], [type="range"], [type="button"]), textarea, [contenteditable="true"]')) first.focus();
    else box.focus();
  };
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal forceMount>
        <Appear kind="scrim" show={open} className={backdrop === 'mist' ? `${mist.glass} ${styles.mist}` : styles.scrim}>
          {null}
        </Appear>
        <Appear kind="sheet" show={open} className={edge === true ? `${styles.dock} ${styles.edgeDock}` : styles.dock}>
          {/* 描述的 id 和 aria-describedby 都交给 Radix 管（每个弹层各生成一个，不重名）：有描述时什么都不传；
              没描述时显式传 undefined，Radix 就不写 aria-describedby，也不报缺描述的警告 */}
          <RD.Content
            ref={content}
            forceMount
            lang={lang}
            className={[styles.content, center === true ? styles.center : '', edge === true ? styles.edge : ''].filter(Boolean).join(' ')}
            onCloseAutoFocus={settle}
            onOpenAutoFocus={openFocus}
            {...(description === undefined ? { 'aria-describedby': undefined } : {})}
          >
            {lead == null ? null : <div className={styles.lead}>{lead}</div>}
            {title === undefined ? null : aside == null ? (
              <RD.Title className={styles.title}>{title}</RD.Title>
            ) : (
              <div className={styles.head}>
                <RD.Title className={styles.title}>{title}</RD.Title>
                {aside}
              </div>
            )}
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
/** 不传 title 时调用方自己放的标题（Radix 的 Title，读屏拿它当弹层名字） */
export const DialogTitle = RD.Title;
