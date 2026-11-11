// 列表页页底的提示条只在这里画（架构 10.1，配 kit/hooks/useListActions.ts）：撤销条、出错条、只读提示条，同一个位置、同时只出一条
// 不进首屏：今天页经 TodayToasts.tsx 按需下载，待办页整页懒加载
import type { ReadonlyGuard } from '../hooks/useReadonly.ts';
import type { ListToast } from '../hooks/useListActions.ts';
import styles from './ListToasts.module.css';
import { ReadonlyToast } from './ReadonlyRow.tsx';
import { UndoToast } from './UndoToast.tsx';

export interface ListToastsProps {
  g: ReadonlyGuard<ListToast>;
  onUndo(id: string): void;
  text: { deleted: string; undo: string; error: string; readonly: string };
  /** 测试 id 前缀：today、todos（today-toast、today-error、today-ro-toast） */
  prefix: string;
}

export function ListToasts({ g, onUndo, text, prefix }: ListToastsProps) {
  const { toast } = g;
  return (
    <>
      {toast?.kind === 'undo' ? (
        <UndoToast
          key={toast.id}
          message={text.deleted}
          undoLabel={text.undo}
          onUndo={() => onUndo(toast.id)}
          onClose={() => g.dismiss(toast)}
          data-testid={`${prefix}-toast`}
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
