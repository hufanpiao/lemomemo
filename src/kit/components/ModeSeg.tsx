// 日历页、纪念日页页顶第二行左边的“周 / 月 / 纪念日”分段（两页同一个组件、同一份样式，大小一致；负责人 11-14：“切到纪念日的时候上面的导航怎么变这大？改成跟周月一样大”）。
// 原来纪念日页自己写了一份整行铺满、三段平分的分段，比日历页大一圈。
// look="slide"（R-436 滑块分段）：整行宽、各段平分，灰色底槽里一块浅色滑块，选中项文字前一个柠檬黄小点，看得见 36 高（点击区仍扩到 44）；
// 纪念日编辑页的类型、阳历阴历两处用它（原来 AnnivPage.module.css 自己那份 .seg 删掉）
import styles from './ModeSeg.module.css';

export interface ModeSegItem {
  readonly key: string;
  readonly label: string;
  readonly pressed: boolean;
  /** 不传 = 当前这一段，点了不动 */
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly testId: string;
}

export function ModeSeg({ label, items, look = 'pill' }: { label: string; items: readonly ModeSegItem[]; look?: 'pill' | 'slide' }) {
  return (
    <div className={look === 'slide' ? `${styles.seg} ${styles.slide}` : styles.seg} role="group" aria-label={label}>
      {items.map((it) => (
        <button key={it.key} type="button" className={styles.segBtn} aria-pressed={it.pressed} disabled={it.disabled} onClick={it.onClick} data-testid={it.testId}>
          {it.label}
        </button>
      ))}
    </div>
  );
}
