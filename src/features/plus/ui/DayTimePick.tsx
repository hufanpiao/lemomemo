// 打字条日期签里“其他日期”“其他时刻”的选择器接口 pickDate / pickTime（不用 iOS 自带的日期时间框，全 App 用自己画的选择器）
// • 自己画的选择器另派人出方案、还没定稿；这里先给占位实现，接口定死，定稿后只换这两个函数的实现，调用方（PlusFields）不用改：
//   pickDate({ value, today, onPick }) → 画在日期签展开区里的一块；占位：从今天起 PICK_DAYS 天一排日期格子（横向滑动），点一个 onPick(那天)
//   pickTime({ value, onPick })        → 同上；占位：06:00 到 23:30 每半小时一格，点一个 onPick('HH:MM')
//   value 是现在签上的值（选中的格子画成选中）；不会给过去的日子（today 起）。不带“取消”：再点一次“其他日期 / 其他时刻”收起，由调用方管
// • 不用 input type=date / time（系统框）
import type { ReactElement } from 'react';
import { addDays, parseDate, weekdayOf, type DateStr } from '../../../../shared/core/date.ts';
import { usePlusLine, usePlusT, type PlusMsgKey } from '../hooks/usePlusT.ts';
import styles from './PlusFields.module.css';

/** 占位日期格子一共几天（从今天起） */
export const PICK_DAYS = 14;
/** 占位时刻：从几点到几点、隔几分钟 */
const TIME_FROM_MIN = 6 * 60;
const TIME_STEP_MIN = 30;

/** 周几的词条（0 = 周日，同 weekdayOf） */
export const WD_KEYS: readonly PlusMsgKey[] = ['plus.f.wd.0', 'plus.f.wd.1', 'plus.f.wd.2', 'plus.f.wd.3', 'plus.f.wd.4', 'plus.f.wd.5', 'plus.f.wd.6'];

export interface DatePick {
  value: DateStr | null;
  today: DateStr;
  onPick(date: DateStr): void;
}

export interface TimePick {
  value: string | null;
  onPick(hm: string): void;
}

const hm = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function DateCells({ value, today, onPick }: DatePick) {
  const t = usePlusT();
  const line = usePlusLine();
  const days = Array.from({ length: PICK_DAYS }, (_, i) => addDays(today, i));
  return (
    <div className={styles.cells} role="group" aria-label={t('plus.f.otherDay', {})} data-testid="pick-date">
      {days.map((d) => {
        const { m, d: dd } = parseDate(d);
        return (
          <button key={d} type="button" className={d === value ? styles.cellOn : styles.cell} aria-pressed={d === value} onClick={() => onPick(d)}>
            <span>{`${m}/${dd}`}</span>
            <span className={styles.cellSub}>{line(WD_KEYS[weekdayOf(d)] ?? 'plus.f.wd.0', {})}</span>
          </button>
        );
      })}
    </div>
  );
}

function TimeCells({ value, onPick }: TimePick) {
  const t = usePlusT();
  const times = Array.from({ length: (24 * 60 - TIME_FROM_MIN) / TIME_STEP_MIN }, (_, i) => hm(TIME_FROM_MIN + i * TIME_STEP_MIN));
  return (
    <div className={styles.cells} role="group" aria-label={t('plus.f.otherTime', {})} data-testid="pick-time">
      {times.map((x) => (
        <button key={x} type="button" className={x === value ? styles.cellOn : styles.cell} aria-pressed={x === value} onClick={() => onPick(x)}>
          {x}
        </button>
      ))}
    </div>
  );
}

/** 其他日期（占位实现，见文件头） */
export function pickDate(p: DatePick): ReactElement {
  return <DateCells {...p} />;
}

/** 其他时刻（占位实现，见文件头） */
export function pickTime(p: TimePick): ReactElement {
  return <TimeCells {...p} />;
}
