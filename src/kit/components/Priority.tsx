// 待办优先级的三个小部件（样式只在 Priority.module.css）：待办页、今天页、待办编辑页共用，不各写一份
// • PrioDot：标题前的优先级彩点（只画、读屏不读，档位由 PrioCycle 的名字说出来）
// • PrioCycle：行右边的 H / M / L 三格并排（当前档那一格亮起）。
//   三格一体是一个按钮（每格只有 20 多宽，分开做三个按钮点按区不够 44）：手指、鼠标点在哪一格就直接设成哪一档（按横向位置算第几格，
//   点在上下外扩区也按横向算）；键盘、读屏按下去没有落点，照旧换下一档（高 → 中 → 低 → 高，shared/logic/todo-row.ts 的 nextPriority）。
//   取舍：看着是三格就该点哪格是哪格，读屏只能是一个按钮，所以只对它保留轮换。
//   字母不翻译，读屏名字由使用方按语言给（“优先级：高，按一下换成中”）；只读行照样回调，由使用方拦下出“要新版本”
// • PrioSeg：编辑页的三档并排（同一套小方块，选中的那一格浅底 + 档位色），和 kit ModeSeg 一样是 aria-pressed 按钮组（role=group）；
//   不用 radiogroup / radio：那套语义要方向键和 roving tabindex，三个按钮各自 Tab 到、按下去就选更简单
// 档位色只用现有令牌（不新增颜色）：高 --p3s、中 --p1s、低 --check-edge；红色只留给逾期
import { nextPriority, PRIORITIES, type Priority } from '../../../shared/logic/todo-row.ts';
import styles from './Priority.module.css';

const LETTER: Readonly<Record<Priority, string>> = { high: 'H', mid: 'M', low: 'L' };

export function PrioDot({ p }: { p: Priority }) {
  return <span className={styles.dot} data-p={p} aria-hidden="true" />;
}

export interface PrioCycleProps {
  p: Priority;
  /** 读屏名字（使用方按语言拼，含“按一下换成哪一档”：键盘、读屏照旧轮换） */
  label: string;
  onChange(next: Priority): void;
  testId: string;
}

/** 点在三格里的第几格：detail 为 0（键盘、读屏按下去）或量不到宽度时回 null（照旧轮换） */
export function cellAt(e: { detail: number; clientX: number; currentTarget: Element }): Priority | null {
  if (e.detail === 0) return null;
  const r = e.currentTarget.getBoundingClientRect();
  if (r.width <= 0) return null;
  const i = Math.floor((PRIORITIES.length * (e.clientX - r.left)) / r.width);
  return PRIORITIES[Math.min(PRIORITIES.length - 1, Math.max(0, i))] ?? null;
}

/** 读屏名字（待办页、日清单、今天页同一种拼法）：name 给每一档的名字，line 是词条“优先级：{p}，按一下换成{next}” */
export function prioLabel(p: Priority, name: (q: Priority) => string, line: (v: { p: string; next: string }) => string): string {
  return line({ p: name(p), next: name(nextPriority(p)) });
}

/** 换档（三处同一份）：只读行拦下出“要新版本”；写入结果照打勾一样报（出错条） */
export function prioSet<R>(ro: boolean, block: () => void, write: () => Promise<R>, report: (r: R) => void): void {
  if (ro) return block();
  void write().then(report);
}

export function PrioCycle({ p, label, onChange, testId }: PrioCycleProps) {
  // 点的是当前已选的那一档：什么都不做、不写库
  const pick = (next: Priority) => (next === p ? undefined : onChange(next));
  return (
    <button type="button" className={styles.tri} data-p={p} aria-label={label} onClick={(e) => pick(cellAt(e) ?? nextPriority(p))} data-testid={testId}>
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
