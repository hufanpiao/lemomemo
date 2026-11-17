// 待办优先级的三个小部件（R-434；样式只在 Priority.module.css）：待办页、今天页、待办编辑页共用，不各写一份
// • PrioDot：标题前的优先级彩点（只画、读屏不读，档位由 PrioCycle 的名字说出来）
// • PrioCycle：行右边的 H / M / L 三格并排（负责人 11-17 选 T-A“行尾 H/M/L 三格并排”，推翻 R-434 确认图第 6 条的单格；当前档那一格亮起），
//   三格一体是一个按钮、点一下换下一档（高 → 中 → 低 → 高，shared/logic/todo-row.ts 的 nextPriority；每格只有 20 多宽，分开点点按区不够 44）；
//   字母不翻译（负责人确认图），读屏名字由使用方按语言给（“优先级：高，点一下换成中”）；只读行照样回调，由使用方拦下出“要新版本”
// • PrioSeg：编辑页的三档并排（同一套小方块，选中的那一格浅底 + 档位色），和 kit ModeSeg 一样是 aria-pressed 按钮组（role=group）；
//   不用 radiogroup / radio：那套语义要方向键和 roving tabindex，三个按钮各自 Tab 到、按下去就选更简单
// 档位色只用现有令牌（不新增颜色）：高 --p3s、中 --p1s、低 --check-edge；红色只留给逾期（R-436）
import { nextPriority, PRIORITIES, type Priority } from '../../../shared/logic/todo-row.ts';
import styles from './Priority.module.css';

const LETTER: Readonly<Record<Priority, string>> = { high: 'H', mid: 'M', low: 'L' };

export function PrioDot({ p }: { p: Priority }) {
  return <span className={styles.dot} data-p={p} aria-hidden="true" />;
}

export interface PrioCycleProps {
  p: Priority;
  /** 读屏名字（使用方按语言拼，含“点一下换成哪一档”） */
  label: string;
  onChange(next: Priority): void;
  testId: string;
}

export function PrioCycle({ p, label, onChange, testId }: PrioCycleProps) {
  return (
    <button type="button" className={styles.tri} data-p={p} aria-label={label} onClick={() => onChange(nextPriority(p))} data-testid={testId}>
      {PRIORITIES.map((q) => (
        <span key={q} className={styles.cell} data-p={q} data-on={q === p ? '' : undefined} aria-hidden="true">
          {LETTER[q]}
        </span>
      ))}
    </button>
  );
}

export interface PrioSegProps {
  value: Priority;
  /** 组的读屏名字（“优先级”） */
  label: string;
  /** 每一档的读屏名字（高、中、低） */
  names: Readonly<Record<Priority, string>>;
  disabled?: boolean;
  onChange(p: Priority): void;
  testId: string;
}

export function PrioSeg({ value, label, names, disabled = false, onChange, testId }: PrioSegProps) {
  return (
    <span className={styles.seg} role="group" aria-label={label} data-testid={testId}>
      {PRIORITIES.map((p) => (
        <button
          key={p}
          type="button"
          className={styles.box}
          data-p={p}
          aria-pressed={p === value}
          aria-label={names[p]}
          disabled={disabled}
          onClick={() => onChange(p)}
          data-testid={`${testId}-${p}`}
        >
          {LETTER[p]}
        </button>
      ))}
    </span>
  );
}
