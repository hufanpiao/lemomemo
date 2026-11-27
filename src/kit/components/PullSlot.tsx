// 下拉搜索的统一挂法（三页只写这一套，随手记手机版、电脑版也是同一处）：
//   const pull = usePullReveal('notes');            // kit/hooks/usePullReveal.ts
//   <main ref={pull.ref}> <header>…</header>
//   <PullSlot pull={pull} keyLabel="搜索" search={<PullSearch pull={pull} own={…} />}>本页列表</PullSlot>
// • 最前面是“搜索”：平时视觉隐藏、Tab 到（:focus-visible）才出现在标题行下面，点了 reveal('key')（键盘、读屏用）；
//   搜索框露着时不画，收起后焦点回到它（usePullReveal 的 close）。放在这里而不是各页的 header 里：随手记电脑版的列表栏没有标题行，
//   放这里三页、两种排法都是同一处。文案由页面传（kit 不引功能的词典）
// • 露出了才挂 search（Suspense + QuietBoundary：那一块还没下载好时满高占位，下载不到时安静不画，本页列表照常）：
//   画在列表上面，一整块（扁搜索框 + 一行小字条数 + 结果 + “用 AI 按意思找 ›”/搜不到的提示）
// • 打了字把本页藏起来、不卸（hidden，列表的状态、动画都留着，清空后原样回来），结果由 search 自己列
//   （三页都查日程、待办、随手记，不做本页就地筛）。包列表的那层是 display: contents，不改原来的排版
// • 占位框里只有放大镜、不写字；框的外形和放大镜同真搜索框一份（pullBarClass、PullGlass）
// • 不用 QuietBoundary.tsx 的 Later：Later 出错和加载中给同一个 fallback，这里出错要不画、加载中要满高占位
import { Suspense, type ReactNode } from 'react';
import type { PullReveal } from '../hooks/usePullReveal.ts';
import { QuietBoundary } from './QuietBoundary.tsx';
import styles from './PullSlot.module.css';

interface PullSlotProps {
  pull: PullReveal;
  keyLabel: string;
  /** 露出时挂的那一块（smart-search 的 PullSearch，懒加载） */
  search: ReactNode;
  children: ReactNode;
}

/** 搜索框的外形（PullSearch 的 .bar 叠在上面补动效、聚焦） */
export const pullBarClass = styles.bar;

/** 放大镜（占位框、真搜索框同一个） */
export const PullGlass = () => <span className={styles.glass} aria-hidden="true" />;

const GhostBar = () => (
  <div className={styles.bar}>
    <PullGlass />
  </div>
);

export function PullSlot({ pull, keyLabel, search, children }: PullSlotProps) {
  return (
    <>
      {pull.enabled && !pull.open ? (
        <button type="button" ref={pull.keyRef} className={styles.key} onClick={() => pull.reveal('key')} data-testid="pull-key">
          {keyLabel}
        </button>
      ) : null}
      {pull.enabled && !pull.open ? (
        <div ref={pull.ghostRef} className={styles.ghost} aria-hidden="true" data-testid="pull-ghost">
          <GhostBar />
        </div>
      ) : null}
      {/* 搜索框那一块露出时才下载：下载好之前占位框满高留着，不先缩回再跳下来 */}
      {/* 包一层 headRef：没打字时页面往上滚，usePullReveal 直接改这一层的透明度，搜索框跟着慢慢收 */}
      {pull.open ? (
        <div ref={pull.headRef} data-testid="pull-head">
          <QuietBoundary name="pull-search">
            <Suspense
              fallback={
                <div className={styles.ghostFull} aria-hidden="true">
                  <GhostBar />
                </div>
              }
            >
              {search}
            </Suspense>
          </QuietBoundary>
        </div>
      ) : null}
      <div className={styles.keep} hidden={pull.searching} data-testid="pull-keep">
        {children}
      </div>
    </>
  );
}
