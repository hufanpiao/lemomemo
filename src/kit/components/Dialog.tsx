// 弹层（Radix Dialog，架构 2.0）：焦点锁定、读屏标注用 Radix；外观全由皮肤变量决定
// CSP 结论（B0 验证，docs/07-开发日志/B0-验证-CSP下Radix与Motion.md）：
//   Radix 的 Dialog.Overlay 里带 react-remove-scroll，会插内联 <style>，被 style-src 'self' 拦。
//   所以这里不用 Dialog.Overlay，遮罩自己画；滚动锁是层栈的（模态层开着时 <html class="scroll-locked">，架构 2.0 做法 ①）
// 进出场（17.1“弹层的遮罩和内容”、17.4 B2；UI-4 L-2、接手清单 M4）：按 17.1 的第一种写法——
//   Portal 和 Content 都 forceMount，挂载和卸载交给 <Appear>（AnimatePresence 等退出动画播完才卸载）：
//   内容 kind="sheet" 从底部滑入、原路滑回（--dur-sheet + --ease-drawer），遮罩 kind="scrim" 淡入淡出（--dur-ui + --ease-out）；
//   减少动态效果时 Appear 只淡入淡出、时长减半（遮罩也减半）。
//   关闭途中 Appear 打 data-state="leaving"，这时两层都不接点按（Dialog.module.css），不挡后面的页面、不会误点正在滑走的按钮。
//   不用 data-state + @keyframes：同一个类名上进、出两段动位移的动画，lemo/reduced-motion-override 认不出覆盖（B2 试过）
// Esc、inert、滚动锁、还焦点都交给层栈（kit/hooks/layers.ts，第三方审查前端-8）：open 时入栈（模态），Radix 只管锁焦点和读屏标注。
//   还焦点（FA-6 ② 审查 L4、L-1、L-2，D-L1～L4、M1 的约定不变）：打开那一刻记下的元素 → 退路 returnFocus；关上那一次提交里就还（层栈 passive 阶段），
//   不等退场动画播完；Radix 的 onCloseAutoFocus（Content 卸载以后）不要默认动作，补一次（settle）：焦点掉在 body 就再还一次
//   （关上时打开按钮还禁用着、退场途中恢复了），在别的元素上就重新聚焦一次让读屏补报（提前还时 Radix 的 aria-hidden 还没撤）
import * as RD from '@radix-ui/react-dialog';
import { useRef, type ReactNode } from 'react';
import { Appear } from '../../motion/components.ts';
import { canFocus, giveBack, useLayer } from '../hooks/useLayer.ts';
import styles from './Dialog.module.css';

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
  /** 标题同一行右边放的东西（纪念日提醒弹层的“恢复默认”，视觉稿 annedit）。不传时渲染结果和原来一样 */
  aside?: ReactNode;
}

export function Dialog({ open, onOpenChange, title, description, children, returnFocus, lead, center, aside }: DialogProps) {
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
      a.focus();
    } else if (layer.layer) giveBack(layer.layer);
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
            onCloseAutoFocus={settle}
            {...(description === undefined ? { 'aria-describedby': undefined } : {})}
          >
            {lead == null ? null : <div className={styles.lead}>{lead}</div>}
            {aside == null ? (
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
