// 今天页待办行下面的一行子任务进度（R-350 方案 5.2，Q5）：只显示“已勾/总数”和一条细进度条，不摊开、不能在这里勾（点这一行进编辑页勾）。
// 这一行在今天页待办的按钮里面：读屏读按钮名字，进度是一句视觉隐藏的文字，进度条不进读屏（按钮里不放 progressbar）。
// 没有子任务时什么都不画。功能入口 ../index.ts 懒加载它（今天页在首屏，这一块不进首屏）
import { useListT } from '../hooks/useTodoList.ts';
import { useSubtaskProgress } from '../hooks/useSubtasks.ts';
import { SubtaskBar } from './SubtaskBar.tsx';
import s from './Subtasks.module.css';

export default function TodaySubtasks({ id }: { id: string }) {
  const t = useListT();
  const p = useSubtaskProgress(id);
  if (!p) return null;
  const { done, total } = p;
  return (
    <span className={s.today} data-testid={`today-subs-${id}`}>
      <span aria-hidden="true">{t('items.progress', { done, total })}</span>
      <span className={s.sr}>{t('items.progress.a11y', { done, total })}</span>
      <SubtaskBar thin done={done} total={total} />
    </span>
  );
}
