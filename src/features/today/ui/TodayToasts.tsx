// 今天页按需下载的只读行和提示条几块（首屏预算 150 KB，FA-2 返工：打开今天页时用不到，不进首屏）。
// 只有一个默认导出，按 part 画哪一块：今天页只写一处 import()，省掉多处懒加载包装和预载列表（首屏差 89 字节，11-06）
// • part="toasts"：页底的提示条——撤销条、出错条、只读提示条（kit 的 ListToasts），加上子任务勾完自动完成的“全部完成 · 撤销”（R-442）；真有一条时才下载
// • part="repeat"：顶部“有 N 条重复事项要新版本才能完整显示 · 更新”（kit 的 RepeatBanner）；有只读行时才下载
// • part="mark"：只读行的行尾标记（kit 的 ReadonlyMark），只读行才画，跟着一起按需下载
// • part="check"：只读行的打勾圆圈（kit 的 RoCheckCircle，读屏名字后接“要更新到新版本才能修改”）；下载完以前今天页先画普通的
import { ReadonlyMark } from '../../../kit/components/ReadonlyMark.tsx';
import type { CheckCircleProps } from '../../../kit/components/CheckCircle.tsx';
import { ListToasts } from '../../../kit/components/ListToasts.tsx';
import { RepeatBanner, RoCheckCircle } from '../../../kit/components/ReadonlyRow.tsx';
import type { ListToast } from '../../../kit/hooks/useListActions.ts';
import type { ReadonlyGuard } from '../../../kit/hooks/useReadonly.ts';
import type { useTodayT } from '../hooks/useTodayT.ts';

/** 勾完最后一个子任务、主待办自动完成的撤销条（R-442；文案是待办那一包给的，undo 刚勾的那项和主待办一起撤回，R-350 Q1）；n 每出一条加一（换一条重新计时） */
export type TodayAutoToast = { kind: 'auto'; n: number; message: string; undo(): void };

export type TodayRoProps =
  | { part: 'mark'; testId: string }
  | ({ part: 'check' } & CheckCircleProps)
  | { part: 'repeat'; onUpdate(): void }
  | { part: 'toasts'; g: ReadonlyGuard<ListToast | TodayAutoToast>; t: ReturnType<typeof useTodayT>; onUndo(id: string): void };

export default function TodayRo(p: TodayRoProps) {
  if (p.part === 'mark') return <ReadonlyMark testId={p.testId} />;
  if (p.part === 'check') return <RoCheckCircle {...p} />;
  if (p.part === 'repeat') return <RepeatBanner onUpdate={p.onUpdate} testId="today-repeat" />;
  const { g, t, onUndo } = p;
  return (
    <ListToasts
      g={g}
      onUndo={onUndo}
      text={{ deleted: t('toast.deleted', {}), undo: t('toast.undo', {}), error: t('err.save', {}), readonly: t('err.readonly', {}) }}
      prefix="today"
      extra={(x: TodayAutoToast) => ({ key: `auto:${x.n}`, message: x.message, onUndo: x.undo, testId: 'today-auto-toast' })}
    />
  );
}
