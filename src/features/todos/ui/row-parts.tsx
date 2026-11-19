// 待办页、日历日清单的待办组交给 kit TodoRow（经 kit/components/useTodoRows.ts）的三个部件：子任务卡片、行尾“未同步”小标记、只读标记和方框（静态的 kit ReadonlyPart）
// （11-17 TodoRow 挪进 kit 时从行里拆出来，两页只写一份）。词条是 kit 自己的（kit/components/useTodoRowWords.ts，独立评审 11-17 第 9、10 条）。
// 今天页给的是首屏画完才挂的同两个部件、按需下载的只读部件（today/ui/TodayPage.tsx）
import { Later } from '../../../kit/components/QuietBoundary.tsx';
import { ReadonlyPart } from '../../../kit/components/ReadonlyMark.tsx';
import type { TodoRowParts } from '../../../kit/components/useTodoRows.ts';
import { UnsyncedRemindMark } from '../../reminders/index.ts';
import InlineSubtasks from './InlineSubtasks.tsx';

/** 行尾“未同步”小标记（提醒那一包懒加载；分包下不来时不画） */
function Mark({ id }: { id: string }) {
  return (
    <Later name="unsynced-mark">
      <UnsyncedRemindMark table="todos" id={id} />
    </Later>
  );
}

export const TODO_PARTS: TodoRowParts = { Subs: InlineSubtasks, Mark, Ro: ReadonlyPart };
