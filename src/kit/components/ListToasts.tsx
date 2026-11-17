// 今天页、待办页页底的提示条在这里画（配 kit/hooks/useListActions.ts）：撤销条、出错条、只读提示条，同一个位置、同时只出一条。
// 页面自己另加的撤销条（待办页打勾、勾完子任务自动完成的“已完成 · 撤销”）也在这里画（extra 给出文案和撤销做什么；审查 11-15 第 4 条：页面上画条只留这一处）。
// 随手记列表页状态也走 useListActions，但条自己画（NotesPage.tsx）：它的出错条和插图提示贴在底部输入行上面、跟着输入行上移，插图提示还带“最近删除”入口，
// 和这里贴底的出错条位置、内容都不同，并进来得给本组件加开关，所以没并
// 不进首屏：今天页经 TodayToasts.tsx 按需下载，待办页整页懒加载
import type { Ref } from 'react';
import type { ReadonlyGuard } from '../hooks/useReadonly.ts';
import type { ListToast } from '../hooks/useListActions.ts';
import styles from './ListToasts.module.css';
import { ReadonlyToast } from './ReadonlyRow.tsx';
import { UndoToast } from './UndoToast.tsx';

/** 页面自己另加的一条撤销条：key 换了就是新的一条（重新计时）；ms 不给是 8 秒 */
export interface ExtraUndo {
  key: string;
  message: string;
  onUndo(): void;
  ms?: number | undefined;
  testId: string;
}

/** X：页面自己另加的提示条（待办页打勾、自动完成的撤销条），extra 把它换成要画的撤销条；不给 extra 就只画 ListToast 的两种 */
export interface ListToastsProps<X = never> {
  g: ReadonlyGuard<ListToast | X>;
  onUndo(id: string): void;
  text: { deleted: string; undo: string; error: string; readonly: string };
  /** 测试 id 前缀：today、todos（today-toast、today-error、today-ro-toast） */
  prefix: string;
  extra?: ((x: X) => ExtraUndo) | undefined;
  /** 挂到页面另加那条撤销条的“撤销”按钮上（kit useDoneFlow 收完最后一行时把焦点移过去） */
  undoRef?: Ref<HTMLButtonElement> | undefined;
}

const isList = (x: unknown): x is ListToast => x !== null && typeof x === 'object' && 'kind' in x && (x.kind === 'undo' || x.kind === 'error');

export function ListToasts<X = never>({ g, onUndo, text, prefix, extra, undoRef }: ListToastsProps<X>) {
  const cur = g.toast;
  const toast = isList(cur) ? cur : null;
  // 撤销条只有一种画法：删除的“已删除 · 撤销”，或页面另加的那一条（solo keep：后出的顶掉前一条，同一时间只留一条）
  const undo: ExtraUndo | null =
    toast?.kind === 'undo'
      ? { key: toast.id, message: text.deleted, onUndo: () => onUndo(toast.id), testId: `${prefix}-toast` }
      : cur !== null && !toast && extra
        ? extra(cur as X)
        : null;
  return (
    <>
      {undo ? (
        <UndoToast
          key={undo.key}
          message={undo.message}
          undoLabel={text.undo}
          onUndo={undo.onUndo}
          onClose={() => g.dismiss(cur as ListToast | X)}
          ms={undo.ms}
          solo="keep"
          undoRef={toast ? undefined : undoRef}
          data-testid={undo.testId}
        />
      ) : toast?.kind === 'error' ? (
        <p className={styles.error} role="alert" data-testid={`${prefix}-error`}>
          {text.error}
        </p>
      ) : null}
      <ReadonlyToast guard={g} message={text.readonly} testId={`${prefix}-ro-toast`} />
    </>
  );
}
