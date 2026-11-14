// 日历页、纪念日页页顶第二行左边的“周 / 月 / 纪念日”分段（两页同一个组件、同一份样式，大小一致；负责人 11-14：“切到纪念日的时候上面的导航怎么变这大？改成跟周月一样大”）。
// 原来纪念日页自己写了一份整行铺满、三段平分的分段，比日历页大一圈；纪念日编辑页里的类型、阳历阴历分段要整行宽，仍用 AnnivPage.module.css 的 .seg
import styles from './ModeSeg.module.css';

export interface ModeSegItem {
  readonly key: string;
  readonly label: string;
  readonly pressed: boolean;
  /** 不传 = 当前这一段，点了不动 */
  readonly onClick?: () => void;
  readonly testId: string;
}

export function ModeSeg({ label, items }: { label: string; items: readonly ModeSegItem[] }) {
  return (
    <div className={styles.seg} role="group" aria-label={label}>
      {items.map((it) => (
        <button key={it.key} type="button" className={styles.segBtn} aria-pressed={it.pressed} onClick={it.onClick} data-testid={it.testId}>
          {it.label}
        </button>
      ))}
    </div>
  );
}
