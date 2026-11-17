// 子任务的进度（R-350 方案 5.1、6.2；负责人 11-17 选 T-A）：
// • SubtaskBar：分段进度条，每项一段，勾上的段填强调色；读屏是一个 progressbar（“子任务已完成 2 项，共 4 项”），分段本身不读。
//   待办卡片（待办页、今天页、日历日清单，SubtaskCard 行底那一条）和编辑页共用
// • SubStage：待办页、日历日清单副行最前面的“起步 / 大半”小标签（三格小图标 + 字）和等宽“1/3”；分档同 kit CheckCircle 的 partStage（方框里的小脸同一个分法）。
//   一项没做时只有“0/3”；标签只是画给眼睛看的，读屏由行里的 progressbar 说
import { partStage } from '../../../kit/components/CheckCircle.tsx';
import { useListT } from '../hooks/useTodoList.ts';
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

export function SubStage({ done, total, testId }: { done: number; total: number; testId: string }) {
  const t = useListT();
  const stage = partStage(done, total);
  return (
    <span className={s.stage} aria-hidden="true" data-testid={testId}>
      {stage ? (
        <span className={s.pill} data-stage={stage}>
          <span className={s.bars}>
            <i />
            <i />
            <i />
          </span>
          {t(stage === 1 ? 'items.stage.1' : 'items.stage.2', {})}
        </span>
      ) : null}
      <span className={s.frac}>{t('items.progress', { done, total })}</span>
    </span>
  );
}
