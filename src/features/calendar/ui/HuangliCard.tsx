// 黄历卡（R-431；负责人 11-15 截图“日历页帮我加这个”）：选中那天清单的标题行下面
// • 左边大字农历日（“初七”），下面小字“丙午年 · 十月”；右边两行：绿底“宜”标 + 事项、红底“忌”标 + 事项，事项用“ · ”隔开
// • 事项多时每行只显示一行、末尾省略号；点卡片展开显示全部，再点收起（整张卡是一个按钮，aria-expanded）。换一天回到收起（DayList 按日期给 key）
// • 那一边没有事项（库写“无”）写“—”；“诸事不宜”照原文；“馀”已在数据里换成“余”（tools/huangli/build.mjs）
// • 颜色走令牌 --yi-bg / --yi-fg、--ji-bg / --ji-fg（tokens.json“黄历卡”一组，深浅两套，build/contrast-pairs.json 的 yi-tag、ji-tag 核对 AA）
import { useState } from 'react';
import type { Huangli } from '../hooks/useHuangli.ts';
import type { CalViewT } from '../hooks/useCalViewT.ts';
import styles from './CalendarPage.module.css';

export function HuangliCard({ h, t }: { h: Huangli; t: CalViewT }) {
  const [open, setOpen] = useState(false);
  const items = (ws: readonly string[]): string => (ws.length === 0 ? t('cal.hl.none', {}) : ws.join(t('cal.hl.sep', {})));
  return (
    <button type="button" className={styles.hl} aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="cal-huangli">
      <span className={styles.hlDate}>
        <span className={styles.hlDay}>{h.day}</span>
        <span className={styles.hlYear}>{t('cal.hl.year', { gz: h.yearGz, m: h.month })}</span>
      </span>
      <span className={styles.hlRows}>
        <span className={styles.hlRow} data-testid="cal-huangli-yi">
          <span className={`${styles.hlTag} ${styles.hlYi}`}>{t('cal.hl.yi', {})}</span>
          <span className={styles.hlItems}>{items(h.yi)}</span>
        </span>
        <span className={styles.hlRow} data-testid="cal-huangli-ji">
          <span className={`${styles.hlTag} ${styles.hlJi}`}>{t('cal.hl.ji', {})}</span>
          <span className={styles.hlItems}>{items(h.ji)}</span>
        </span>
      </span>
    </button>
  );
}
