// 今日运势卡：日清单面板最上面一张，DayList 懒加载本文件（不进日历页那一包，更不进首屏）
// 唯一参考：方案页 方案-八字-B.html（card()、renderSheet()）；参考里没有的一律不加
// • 填了生日：整张是按钮（点开详情）。第一行星星紧跟一句白话（韩文最多两行）；第二行小字“本色 · 幸运色圆点和颜色名 · 幸运数字 N”；右边小箭头。
//   读屏只读按钮名字（一句话说全），里面的字对读屏隐藏
// • 没填：一行“★ 想按八字看每天的运势？”+ 黄色“填生日”按钮
// • 算法和文案（shared/logic/anniv/lunar-fortune.ts）经 core/anniv-lib.ts 的 FORTUNE_LIB 按需加载：填了生日或打开填写层才下载；
//   下载中先占一行卡片的高度（fortune-slot.tsx 的 FORTUNE_HOLD），下载失败、算不出来时什么都不渲染（DayList 那一格空了就不占位）
// • 界面语言 L 在这里算一次，传给弹层；字的取法是 hooks/useFortuneBirth.ts 的 fortuneWords（卡片和详情共用）
// • 弹层关上时焦点还给卡片这个位置：卡片按钮和“填生日”按钮挂同一个 anchor（清除生日以后卡片换成“填生日”，焦点落在它上面，不掉到 body）
// • 生日读写在 hooks/useFortuneBirth.ts；弹层（详情、填生日）在 FortuneSheet.tsx
// • 卡片和详情里不出现术语（比肩、日主之类只在 lunar-fortune-data.ts 的注释里）
import { useRef, useState } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { fortuneWords, useFortuneBirth, useFortuneLib, type Lang } from '../hooks/useFortuneBirth.ts';
import { useFortuneT } from '../hooks/useFortuneT.ts';
import { FORTUNE_HOLD } from './fortune-slot.tsx';
import { FortuneSheet, Stars, type SheetKind } from './FortuneSheet.tsx';
import styles from './Fortune.module.css';

const CHEV = (
  <svg className={styles.chev} viewBox="0 0 8 14" aria-hidden="true">
    <path d="M1.5 1.5L6.5 7l-5 5.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export interface FortuneCardProps {
  /** 选中的那一天（看哪天的运势） */
  date: DateStr;
  /** 今天（生日不晚于今天） */
  today: DateStr;
}

export function FortuneCard({ date, today }: FortuneCardProps) {
  const t = useFortuneT();
  const L: Lang = useUi((s) => s.locale) === 'ko-KR' ? 1 : 0;
  const fb = useFortuneBirth(today);
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const lib = useFortuneLib(fb.birth !== null || sheet !== null);
  const F = typeof lib === 'string' ? null : lib;
  const sheetEl = <FortuneSheet kind={sheet} onKind={setSheet} date={date} today={today} L={L} fb={fb} lib={F} anchor={() => anchor.current} />;

  if (fb.birth === null) {
    return (
      <>
        <div className={styles.fc} data-testid="fortune-empty">
          <div className={styles.bE}>
            <i aria-hidden="true">★</i>
            {t('fortune.empty', {})}
          </div>
          <button ref={anchor} type="button" className={styles.setBtn} onClick={() => setSheet('setup')} data-testid="fortune-set">
            {t('fortune.set', {})}
          </button>
        </div>
        {sheetEl}
      </>
    );
  }
  if (F === null) return lib === 'loading' ? FORTUNE_HOLD : null;
  const f = F.fortuneOf(fb.birth, date);
  if (f === null) return null;
  const { me, tip, color } = fortuneWords(F, f, L);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={styles.fc}
        aria-haspopup="dialog"
        aria-label={t('fortune.cardLabel', { me, n: f.stars, tip, c: color, k: f.num })}
        onClick={() => setSheet('detail')}
        data-testid="fortune-card"
        data-stars={f.stars}
      >
        <span className={styles.bL} aria-hidden="true">
          <span className={styles.bTop} data-testid="fortune-tip">
            <Stars n={f.stars} />
            {tip}
          </span>
          <span className={styles.meta} data-testid="fortune-meta">
            {me} · <span className={`${styles.sw} ${styles[`k${f.color}`] ?? ''}`} /> {color} · {t('fortune.meta.num', { n: f.num })}
          </span>
        </span>
        {CHEV}
      </button>
      {sheetEl}
    </>
  );
}

export default FortuneCard;
