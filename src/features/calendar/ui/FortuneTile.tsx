// 今天页没日程时组合区里的“今日小运”小方块（组合区左边那块）：
// 和日历日清单的今日运势卡（FortuneCard.tsx）是同一件事——同一个生日（hooks/useFortuneBirth.ts）、同一套算法和文案
// （FORTUNE_LIB 按需下载）、同一个详情和填生日弹层（FortuneSheet.tsx），这里只换一个外形，不另做一套
// • 填了生日：整块是按钮——小字“今日小运”、星星、一句白话（FortuneCard 第一行那句）、底部“看详情 ›”；点了开详情。读屏念的同 FortuneCard 的 cardLabel
// • 没填生日：同一块里用运势卡现成的两句——“想按八字看每天的运势？”、底部“填生日 ›”，点了开填生日那一层
// • 算法下载中：先画小字和空的星星位，不跳高；下载失败、算不出来时整块不画（TodayFun 那边这一格空着）
// • 外框（底色、圆角、内边距）由今天页给 className，字号、间距在 Fortune.module.css 的 .t*
// • 日历模块对外经 index.ts 懒加载导出，不进今天页首屏
import { useRef, useState } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { fortuneWords, useFortuneBirth, useFortuneLib, type Lang } from '../hooks/useFortuneBirth.ts';
import { useFortuneT } from '../hooks/useFortuneT.ts';
import { FortuneSheet, Stars, type SheetKind } from './FortuneSheet.tsx';
import styles from './Fortune.module.css';

export interface FortuneTileProps {
  today: DateStr;
  /** 外框（今天页组合区的小方块样式；网页版宽屏今天页是 kit 的卡片） */
  className: string;
  /** 外形：'tile' 组合区小方块（默认）；'card' 网页版宽屏今天页第一行右边的今日运势卡
   *  （标题行“今日运势 · 看详情 ›”、星星、一句白话、“● 幸运色 黄色 · 幸运数字 7”）。生日、算法、详情弹层同一套 */
  shape?: 'tile' | 'card';
}

export default function FortuneTile({ today, className, shape = 'tile' }: FortuneTileProps) {
  const t = useFortuneT();
  const L: Lang = useUi((s) => s.locale) === 'ko-KR' ? 1 : 0;
  const fb = useFortuneBirth(today);
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const lib = useFortuneLib(fb.birth !== null || sheet !== null);
  const F = typeof lib === 'string' ? null : lib;
  const sheetEl = <FortuneSheet kind={sheet} onKind={setSheet} date={today} today={today} L={L} fb={fb} lib={F} anchor={() => anchor.current} />;
  const card = shape === 'card';
  const title = <span className={styles.tMini}>{t('fortune.tile', {})}</span>;
  /** 卡片外形的标题行：左“今日运势”，右“看详情 ›”/“填生日 ›”（小方块是底部那一行 tMore） */
  const cardHead = (go: string) => (
    <span className={styles.cH}>
      <span>{t('fortune.day', {})}</span>
      <span>{go} <span aria-hidden="true">›</span></span>
    </span>
  );

  if (fb.birth === null) {
    return (
      <>
        <button ref={anchor} type="button" className={`${className} ${card ? styles.card : styles.tile}`} onClick={() => setSheet('setup')} data-testid="fortune-tile-set">
          {card ? cardHead(t('fortune.set', {})) : title}
          <span className={styles.tK1}>{t('fortune.empty', {})}</span>
          {card ? null : <span className={styles.tMore}>{t('fortune.set', {})} <span aria-hidden="true">›</span></span>}
        </button>
        {sheetEl}
      </>
    );
  }
  if (F === null) {
    if (lib !== 'loading') return null;
    return (
      <div className={`${className} ${card ? styles.card : styles.tile}`} aria-hidden="true" data-testid="fortune-tile-wait">
        {card ? cardHead(t('fortune.more', {})) : title}
      </div>
    );
  }
  const f = F.fortuneOf(fb.birth, today);
  if (f === null) return null;
  const { me, tip, color } = fortuneWords(F, f, L);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`${className} ${card ? styles.card : styles.tile}`}
        aria-haspopup="dialog"
        aria-label={t('fortune.cardLabel', { me, n: f.stars, tip, c: color, k: f.num })}
        onClick={() => setSheet('detail')}
        data-testid="fortune-tile"
        data-stars={f.stars}
      >
        {card ? cardHead(t('fortune.more', {})) : title}
        <span className={styles.tStars} aria-hidden="true">
          <Stars n={f.stars} />
        </span>
        <span className={card ? styles.cTip : styles.tK1} aria-hidden="true">{tip}</span>
        {card ? (
          <span className={styles.cMeta} aria-hidden="true">
            <span className={`${styles.sw} ${styles[`k${f.color}`] ?? ''}`} />
            {t('fortune.luckColor', {})} {color} · {t('fortune.meta.num', { n: f.num })}
          </span>
        ) : (
          <span className={styles.tMore} aria-hidden="true">{t('fortune.more', {})} ›</span>
        )}
      </button>
      {sheetEl}
    </>
  );
}
