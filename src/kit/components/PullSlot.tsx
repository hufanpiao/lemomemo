// 下拉搜索的统一挂法（R-437；评审第 7 条：三页只写这一套，随手记手机版、电脑版也是同一处）：
//   const pull = usePullReveal('notes');            // kit/hooks/usePullReveal.ts
//   <main ref={pull.ref}> <header>…</header>
//   <PullSlot pull={pull} keyLabel="搜索本页" search={(part) => <PullSearch part={part} pull={pull} scope="note" found={n} onOpen={open} />}>本页列表</PullSlot>
// • 最前面是“搜索本页”：平时视觉隐藏、Tab 到（:focus-visible）才出现在标题行下面，点了 reveal('key')（键盘、读屏用，评审第 3 条）；
//   搜索框露着时不画，收起后焦点回到它（usePullReveal 的 close）。放在这里而不是各页的 header 里：随手记电脑版的列表栏没有标题行，
//   放这里三页、两种排法都是同一处。文案由页面传（kit 不引功能的词典）
// • 露出了才挂 search（Suspense + QuietBoundary：那一块还没下载好时不占位，下载不到时安静不画，本页列表照常）：
//   search('head') 画在列表上面（扁搜索框 + 一行小字条数），打了字时 search('foot') 画在列表下面（“用 AI 按意思找 ›”，搜不到时居中提示）
// • 就地筛（R-447 S-B）：列表照原样留着，页面按 pull.shows(id) 只画命中的、标题用 PullHit 给命中的字加短下划线；
//   inPlace=false（日历页：月历和日清单不是一整串记录，没法就地筛）打了字把本页列表藏起来、不卸（评审第 8 条：hidden，列表的状态、动画都留着，
//   清空后原样回来），结果由 search('head') 自己列。包列表的那层是 display: contents，不改原来的排版
import { Suspense, type ReactNode } from 'react';
import type { PullReveal } from '../hooks/usePullReveal.ts';
import { Marked } from './Marked.tsx';
import { QuietBoundary } from './QuietBoundary.tsx';
import styles from './PullSlot.module.css';

export type PullPart = 'head' | 'foot';

interface PullSlotProps {
  pull: PullReveal;
  keyLabel: string;
  search(part: PullPart): ReactNode;
  /** 就地筛（默认）；false：打了字把本页列表藏起来（日历页） */
  inPlace?: boolean;
  children: ReactNode;
}

const part = (node: ReactNode, fallback: ReactNode = null) => (
  <QuietBoundary name="pull-search">
    <Suspense fallback={fallback}>{node}</Suspense>
  </QuietBoundary>
);

/** 占位框里那一条：外形同 PullSearch 的 .bar（放大镜 + 灰字） */
const GhostBar = ({ label }: { label: string }) => (
  <div className={styles.ghostBar}>
    <svg className={styles.ghostGlass} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </svg>
    <span>{label}</span>
  </div>
);

export function PullSlot({ pull, keyLabel, search, inPlace = true, children }: PullSlotProps) {
  return (
    <>
      {pull.enabled && !pull.open ? (
        <button type="button" ref={pull.keyRef} className={styles.key} onClick={() => pull.reveal('key')} data-testid="pull-key">
          {keyLabel}
        </button>
      ) : null}
      {pull.enabled && !pull.open ? (
        <div ref={pull.ghostRef} className={styles.ghost} aria-hidden="true" data-testid="pull-ghost">
          <GhostBar label={keyLabel} />
        </div>
      ) : null}
      {/* 搜索框那一块露出时才下载：下载好之前占位框满高留着，不先缩回再跳下来（整块评审第 1 条） */}
      {/* 包一层 headRef：没打字时页面往上滚，usePullReveal 直接改这一层的透明度，搜索框跟着慢慢收（负责人 11-20） */}
      {pull.open ? (
        <div ref={pull.headRef} data-testid="pull-head">
          {part(
            search('head'),
            <div className={styles.ghostFull} aria-hidden="true">
              <GhostBar label={keyLabel} />
            </div>,
          )}
        </div>
      ) : null}
      <div className={styles.keep} hidden={!inPlace && pull.searching} data-testid="pull-keep">
        {children}
      </div>
      {pull.open && pull.searching ? part(search('foot')) : null}
    </>
  );
}

/** 命中的字那道短下划线的样子（日历页的结果行用查找面板的行，高亮换成这个） */
export const pullHitClass = styles.hit;

/** 就地筛时行标题里命中的字下面一道短下划线（R-447 S-B 方案图）；没在筛时原样回文字 */
export function PullHit({ pull, text }: { pull: PullReveal; text: string }): ReactNode {
  return <Marked text={text} q={pull.markQ} className={pullHitClass} />;
}
