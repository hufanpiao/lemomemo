// 子任务的分段进度条（R-350 方案 5.1、6.2）：每项一段，勾上的段填强调色；读屏是一个 progressbar（“子任务已完成 2 项，共 4 项”），分段本身不读。
// 列表页卡片、今天页、编辑页共用；thin 是今天页的细条
import s from './Subtasks.module.css';

/** 不给 label：只画、不进读屏（今天页那一行在按钮里，读屏走文字） */
export function SubtaskBar({ done, total, label, thin = false, testId }: { done: number; total: number; label?: string; thin?: boolean; testId?: string }) {
  const bar = label !== undefined;
  return (
    <span
      role={bar ? 'progressbar' : undefined}
      aria-hidden={bar ? undefined : true}
      aria-valuemin={bar ? 0 : undefined}
      aria-valuemax={bar ? total : undefined}
      aria-valuenow={bar ? done : undefined}
      aria-valuetext={label}
      className={thin ? `${s.bar} ${s.thin}` : s.bar}
      data-testid={testId}
    >
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={s.seg} data-on={i < done ? '' : undefined} aria-hidden="true" />
      ))}
    </span>
  );
}
