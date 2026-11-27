// 日清单面板最上面那张今日运势卡的位置：卡片本身（FortuneCard.tsx 和弹层、词典）按需下载，
// 不进日历页那一包，更不进首屏。下载中先占一行卡片的高度（和卡片里等算法时同一个 .hold），下载失败、画出错时这一格什么都不渲染，
// DayList 那边外层是空的就不占位、不画分隔线
import { lazy, Suspense } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import styles from './Fortune.module.css';

const FortuneCard = lazy(() => import('./FortuneCard.tsx'));

/** 占一行卡片高度的占位：这里（卡片那一包还没下载好）和 FortuneCard（算法还没下载好）共用这一个 */
export const FORTUNE_HOLD = <div className={styles.hold} aria-hidden="true" data-testid="fortune-wait" />;

export function FortuneSlot({ date, today }: { date: DateStr; today: DateStr }) {
  return (
    <QuietBoundary name="cal-fortune">
      <Suspense fallback={FORTUNE_HOLD}>
        <FortuneCard date={date} today={today} />
      </Suspense>
    </QuietBoundary>
  );
}
