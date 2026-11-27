// 子任务的进度：
// • SubtaskBar：分段进度条，每项一段，勾上的段填强调色；读屏是一个 progressbar（“子任务已完成 2 项，共 4 项”），分段本身不读。
//   待办卡片（待办页、今天页、日历日清单，SubtaskCard 行底那一条）和编辑页共用
// • 副行最前面的“起步 / 大半”小标签和“1/3”在 kit TodoRow（今天页首屏也要画，样式在 kit List.module.css 的 .stage）
import s from './Subtasks.module.css';

export function SubtaskBar({ done, total, label, testId }: { done: number; total: number; label: string; testId?: string }) {
  return (
    <span
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-valuetext={label}
      className={s.bar}
      data-testid={testId}
    >
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={s.seg} data-on={i < done ? '' : undefined} aria-hidden="true" />
      ))}
    </span>
  );
}
