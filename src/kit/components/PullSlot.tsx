// 下拉搜索的统一挂法（R-437；评审第 7 条：三页只写这一套，随手记手机版、电脑版也是同一处）：
//   const pull = usePullReveal('notes');            // kit/hooks/usePullReveal.ts
//   <main ref={pull.ref}> <header>…</header>
//   <PullSlot pull={pull} keyLabel="搜索本页" search={<PullSearch pull={pull} scope="note" onOpen={open} />}>本页列表</PullSlot>
// • 最前面是“搜索本页”：平时视觉隐藏、Tab 到（:focus-visible）才出现在标题行下面，点了 reveal('key')（键盘、读屏用，评审第 3 条）；
//   搜索框露着时不画，收起后焦点回到它（usePullReveal 的 close）。放在这里而不是各页的 header 里：随手记电脑版的列表栏没有标题行，
//   放这里三页、两种排法都是同一处。文案由页面传（kit 不引功能的词典）
// • 露出了才挂 search（Suspense + QuietBoundary：那一块还没下载好时不占位，下载不到时安静不画，本页列表照常）
// • 打了字把本页列表藏起来、不卸（评审第 8 条：hidden，列表的状态、动画都留着，清空后原样回来）。包列表的那层是 display: contents，不改原来的排版
import { Suspense, type ReactNode } from 'react';
import type { PullReveal } from '../hooks/usePullReveal.ts';
import { QuietBoundary } from './QuietBoundary.tsx';
import styles from './PullSlot.module.css';

export function PullSlot({ pull, keyLabel, search, children }: { pull: PullReveal; keyLabel: string; search: ReactNode; children: ReactNode }) {
  return (
    <>
      {pull.enabled && !pull.open ? (
        <button type="button" ref={pull.keyRef} className={styles.key} onClick={() => pull.reveal('key')} data-testid="pull-key">
          {keyLabel}
        </button>
      ) : null}
      {pull.open ? (
        <QuietBoundary name="pull-search">
          <Suspense fallback={null}>{search}</Suspense>
        </QuietBoundary>
      ) : null}
      <div className={styles.keep} hidden={pull.searching} data-testid="pull-keep">
        {children}
      </div>
    </>
  );
}
