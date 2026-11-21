// 今天页按需下载的只读行和提示条几块（首屏预算 150 KB，FA-2 返工：打开今天页时用不到，不进首屏）。
// 只有一个默认导出，按 part 画哪一块：今天页只写一处 import()，省掉多处懒加载包装和预载列表（首屏差 89 字节，11-06）
// • part="toasts"：页底的提示条——撤销条、出错条、只读提示条（kit 的 ListToasts），加上打勾完成、子任务勾完自动完成的“已完成 · 撤销”
//  （kit/components/useDoneFlow.ts 的 undoOf，同待办页）、推迟到明天的“已推迟到明天 · 撤销”；参数就是 kit/components/useTodoRows.ts 回来的 toasts；真有一条时才下载
// • part="repeat"：顶部“有 N 条重复事项要新版本才能完整显示 · 更新”（kit 的 RepeatBanner）；有只读行时才下载
// • part="mark"、part="check"：只读行的行尾标记、打勾方框（kit ReadonlyMark.tsx 的 ReadonlyPart；日程行和 kit TodoRow 的 parts.Ro 用），
//   只读行才画，跟着一起按需下载；方框下载完以前今天页先画普通的（TodayPage.tsx 的 RoPart）
import { ReadonlyPart, type ReadonlyPartProps } from '../../../kit/components/ReadonlyMark.tsx';
import { ListToasts, type ListToastsProps } from '../../../kit/components/ListToasts.tsx';
import { RepeatBanner } from '../../../kit/components/ReadonlyRow.tsx';
import type { RowToast } from '../../../kit/components/useTodoRows.ts';

export type TodayRoProps =
  | ReadonlyPartProps
  | { part: 'repeat'; onUpdate(): void }
  | ({ part: 'toasts' } & ListToastsProps<RowToast>);

export default function TodayRo(p: TodayRoProps) {
  if (p.part === 'mark' || p.part === 'check') return <ReadonlyPart {...p} />;
  if (p.part === 'repeat') return <RepeatBanner onUpdate={p.onUpdate} testId="today-repeat" />;
  return <ListToasts {...p} />;
}
