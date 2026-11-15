// 日历页、纪念日页页顶第二行左边的“周 / 月 / 纪念日”分段（两页同一个组件、同一份样式，大小一致；负责人 11-14：“切到纪念日的时候上面的导航怎么变这大？改成跟周月一样大”）。
// 原来纪念日页自己写了一份整行铺满、三段平分的分段，比日历页大一圈。
// look="slide"（R-436 滑块分段）：各段平分，灰色底槽里一块浅色滑块，选中项文字前一个柠檬黄小点，看得见 36 高（点击区仍扩到 44）；
// 纪念日编辑页的类型、阳历阴历两处用它（原来 AnnivPage.module.css 自己那份 .seg 删掉），设置页的分段行（SettingsSegRow）也用它
// （原来 kit 设置组件自己那份 Segmented 删掉；设置卡片里底槽改色由使用方覆盖变量 --seg-track，见 Settings.module.css 的 .segRow）
import styles from './ModeSeg.module.css';

export interface ModeSegItem {
  readonly key: string;
  readonly label: string;
  readonly pressed: boolean;
  /** 不传 = 当前这一段，点了不动 */
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly testId?: string | undefined;
  /** 文字本身的语言（例如“한국어”标 ko），读屏按这个语言念 */
  readonly lang?: string | undefined;
}

export interface ModeSegProps {
  /** 组名（aria-label）；有 labelledBy 时不用 */
  label?: string;
  /** 组名取页面上已有的元素（aria-labelledby，例如设置行的行名） */
  labelledBy?: string;
  /** 说明的 id（aria-describedby） */
  describedBy?: string | undefined;
  items: readonly ModeSegItem[];
  look?: 'pill' | 'slide';
  testId?: string | undefined;
}

export function ModeSeg({ label, labelledBy, describedBy, items, look = 'pill', testId }: ModeSegProps) {
  return (
    <div
      className={look === 'slide' ? `${styles.seg} ${styles.slide}` : styles.seg}
      role="group"
      aria-label={labelledBy === undefined ? label : undefined}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      data-testid={testId}
    >
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          className={styles.segBtn}
          aria-pressed={it.pressed}
          disabled={it.disabled}
          onClick={it.onClick}
          lang={it.lang}
          data-value={it.key}
          data-testid={it.testId}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
