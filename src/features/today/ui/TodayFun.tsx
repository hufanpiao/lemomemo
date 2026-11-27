// 今天页没日程时的组合区：顺手做 + 今日小运 + 这周做完（带七根小柱），不带吉祥物
// 唯一参考：柠檬记APP-本机资料/设计方案/2026-11-22_今天页空白趣味/方案4.html 的 combo()（截图 方案4_组合_1扁平圆胖_浅色/深色_430x932.png），去掉右上角柠檬；参考里没有的一律不加
// • 位置：“今天的安排 0”下面，取代原来那一行“今天没有安排”（TodayPage 的 listItem；今天的日程和待办都是 0 件时才挂，按需下载，不进首屏；
//   下载中、下不来时照旧画“今天没有安排”）。日期下的纪念日胶囊、“现在”卡是今天页原有的（AnnivLine、NowCard），这里不画
// • 顺手做（定稿 .tile .tq .trow）：“今天空着，要不要把它做了？”+ 一件没定日期的待办（方框、标题、“没定日期 · N 天前记的”）+ 黄色“放进今天”；
//   挑哪一件在 data/today-fun.ts 的 quickTodo（和待办页同一个排序，跳过只读行）；没有没定日期的待办时这一块不画。
//   方框只是样子（定稿里只有“放进今天”可按），读屏不念。“放进今天”= 截止日改成今天，这一件进了今天的安排，组合区跟着收起
// • 今日小运（定稿 .pair 左块）：日历模块的 FortuneTile（和日历日清单的今日运势卡同一个生日、算法、详情弹层，不另做一套）
// • 这周做完（定稿 .pair 右块 + C1 七根小柱）：件数、比上周、七根小柱；一周从周日起，柱子 日 一 二 三 四 五 六（定稿图是周一起，以周日起为准）；
//   今天那根下面的字加深加粗；没有做完的那天是一截灰
// • 运行日志：挂上时记一行 today-fun show（有没有顺手做、这周几件，不记标题）；点按由全局运行日志按 data-testid 记；“放进今天”的结果在 hooks/useTodayFun.ts 记
import { useEffect } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { Pressable } from '../../../motion/components.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { FortuneTile } from '../../calendar/index.ts';
import { barHeight, useFunT, useTodayFun } from '../hooks/useTodayFun.ts';
import styles from './TodayFun.module.css';

export default function TodayFun({ today }: { today: DateStr }) {
  const t = useFunT();
  const { quick, week, toToday } = useTodayFun(today);
  const hasQuick = quick !== null;
  useEffect(() => {
    rlog(`today-fun show quick=${hasQuick ? 1 : 0} week=${week.n} diff=${week.diff}`);
  }, [hasQuick, week.n, week.diff]);

  const wd = t('fun.wd', {});
  const max = Math.max(...week.bars);
  const vs = week.diff > 0 ? t('fun.weekUp', { n: week.diff }) : week.diff < 0 ? t('fun.weekDown', { n: -week.diff }) : t('fun.weekSame', {});
  const days = week.bars.map((n, i) => t('fun.weekDay', { w: wd[i] ?? '', n })).join('，');

  return (
    <div className={styles.fun} data-testid="today-fun">
      {quick ? (
        <div className={styles.tile} data-testid="today-fun-quick">
          <p className={styles.tq}>{t('fun.quickQ', {})}</p>
          <div className={styles.trow}>
            <span className={styles.box} aria-hidden="true" />
            <div className={styles.tt}>
              <div className={styles.ttl}>{quick.todo.title}</div>
              <small className={styles.meta}>{quick.ago > 0 ? t('fun.quickMeta', { n: quick.ago }) : t('fun.quickMetaToday', {})}</small>
            </div>
            <Pressable
              className={styles.go}
              aria-label={t('fun.quickGoLabel', { title: quick.todo.title })}
              onClick={() => void toToday(quick.todo.id)}
              data-testid="today-fun-go"
            >
              {t('fun.quickGo', {})}
            </Pressable>
          </div>
        </div>
      ) : null}
      <div className={styles.pair}>
        <QuietBoundary name="today-fun-fortune">
          <FortuneTile today={today} className={`${styles.tile} ${styles.small}`} />
        </QuietBoundary>
        <div className={`${styles.tile} ${styles.small}`} data-testid="today-fun-week" data-n={week.n} data-diff={week.diff}>
          <span className={styles.mini}>{t('fun.week', {})}</span>
          <div className={styles.wkTop}>
            <span className={styles.k2}>
              {week.n}
              <small>{t('fun.weekUnit', {})}</small>
            </span>
            <span className={week.diff > 0 ? `${styles.k3} ${styles.up}` : styles.k3}>{vs}</span>
          </div>
          <div className={styles.bars} role="img" aria-label={days} data-testid="today-fun-bars">
            {week.bars.map((n, i) => (
              <div key={wd[i] ?? i} className={i === week.todayIdx ? styles.today : undefined} data-n={n}>
                <div className={styles.b}>
                  <i className={n ? undefined : styles.off} style={{ height: `${barHeight(n, max)}px` }} />
                </div>
                <span>{wd[i]}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
