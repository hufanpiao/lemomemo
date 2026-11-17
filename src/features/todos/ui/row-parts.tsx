// 待办页、日历日清单的待办组交给 kit TodoRow（经 kit/components/useTodoRows.ts）的数据：词条、子任务卡片、行尾“未同步”小标记、只读标记和方框（静态的 kit ReadonlyPart）（11-17 TodoRow 挪进 kit 时从行里拆出来，
// 两页原来经 hooks/useTodoRowActions.ts 共用，这里同样只写一份）。今天页给的是它自己词典里的词条、首屏画完才挂的同两个部件、按需下载的只读部件（today/ui/TodayPage.tsx）
import { Suspense } from 'react';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { ReadonlyPart } from '../../../kit/components/ReadonlyMark.tsx';
import type { TodoRowParts, TodoRowWords } from '../../../kit/components/useTodoRows.ts';
import { UnsyncedRemindMark } from '../../reminders/index.ts';
import { useListT } from '../hooks/useTodoList.ts';
import InlineSubtasks from './InlineSubtasks.tsx';

/** 行尾“未同步”小标记（提醒那一包懒加载；分包下不来时不画） */
function Mark({ id }: { id: string }) {
  return (
    <QuietBoundary name="unsynced-mark">
      <Suspense fallback={null}>
        <UnsyncedRemindMark table="todos" id={id} />
      </Suspense>
    </QuietBoundary>
  );
}

export const TODO_PARTS: TodoRowParts = { Subs: InlineSubtasks, Mark, Ro: ReadonlyPart };

export function useRowWords(): TodoRowWords {
  const t = useListT();
  return {
    done: t('list.done', {}),
    undoDone: t('list.undoDone', {}),
    doneToast: t('list.doneToast', {}),
    prio: (p) => t(`list.prio.${p}`, {}),
    prioLine: (v) => t('list.prio', v),
    stage: (s) => t(s === 1 ? 'items.stage.1' : 'items.stage.2', {}),
    toasts: { deleted: t('list.deleted', {}), undo: t('list.undo', {}), error: t('list.err.save', {}), readonly: t('list.err.readonly', {}) },
  };
}
