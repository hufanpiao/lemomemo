// 黄历卡（R-431；负责人 11-15 截图“日历页帮我加这个”）：选中那天清单的标题行下面
// • 左边大字农历日（“初七”），下面小字“丙午年 · 十月”；右边两行：绿底“宜”标 + 事项、红底“忌”标 + 事项，事项用“ · ”隔开
// • 事项多时每行只显示一行、末尾省略号。只有宜或忌真被截断（scrollWidth > clientWidth）时，卡片才可点：
//   盖一层铺满整卡的透明按钮（aria-expanded），点了展开显示全部、再点收起；没截断就是普通的块，不是按钮（R-431 独立评审第 3 条）。
//   参考图上没有箭头，画面不加。换一天回到收起（DayList 按日期给 key）；宽度变了（转屏）用 ResizeObserver 重新量
// • 读屏（独立评审第 3 条）：按钮的名字是短的一句（“黄历，初七，丙午年十月，宜 5 项，忌 2 项”），此时左边日期那一栏对读屏隐藏（名字里已有）；
//   宜、忌两行不在按钮里，读屏直接读得到；日期、宜、忌各是一块（div），不连读
// • 那一边没有事项（库写“无”）画“—”，读屏读“无”（独立评审第 8 条）；“诸事不宜”照原文；“馀”已在数据里换成“余”（tools/huangli/build.mjs）
// • 颜色走令牌 --yi-bg / --yi-fg、--ji-bg / --ji-fg（tokens.json“黄历卡”一组，深浅两套，build/contrast-pairs.json 的 yi-tag、ji-tag 核对 AA）
import { useLayoutEffect, useRef, useState, type Ref } from 'react';
import type { Huangli } from '../hooks/useHuangli.ts';
import type { CalViewT } from '../hooks/useCalViewT.ts';
import common from './cal-common.module.css';
import styles from './DayList.module.css';

const cut = (el: HTMLElement | null): boolean => el !== null && el.scrollWidth > el.clientWidth;

/** 收起时量宜、忌两行有没有被截断；展开时不量（保留上一次的结果） */
function useClipped(open: boolean, h: Huangli) {
  const box = useRef<HTMLDivElement>(null);
  const yi = useRef<HTMLSpanElement>(null);
  const ji = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    if (open) return undefined;
    const measure = (): void => setClipped(cut(yi.current) || cut(ji.current));
    measure();
    if (typeof ResizeObserver === 'undefined' || box.current === null) return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [open, h]);
  return { box, yi, ji, clipped };
}

function Items({ ws, t, at }: { ws: readonly string[]; t: CalViewT; at: Ref<HTMLSpanElement> }) {
  return (
    <span ref={at} className={styles.hlItems}>
      {ws.length > 0 ? (
        ws.join(t('cal.hl.sep', {}))
      ) : (
        <>
          <span aria-hidden="true">{t('cal.hl.none', {})}</span>
          <span className={common.srOnly}>{t('cal.hl.noneSr', {})}</span>
        </>
      )}
    </span>
  );
}

export function HuangliCard({ h, t }: { h: Huangli; t: CalViewT }) {
  const [open, setOpen] = useState(false);
  const { box, yi, ji, clipped } = useClipped(open, h);
  const toggle = open || clipped;
  return (
    <div ref={box} className={`${styles.hl} ${open ? styles.hlOpen : ''}`} data-testid="cal-huangli">
      {toggle ? (
        <button
          type="button"
          className={styles.hlHit}
          aria-expanded={open}
          aria-label={t('cal.hl.label', { day: h.day, gz: h.yearGz, m: h.month, yi: h.yi.length, ji: h.ji.length })}
          onClick={() => setOpen((o) => !o)}
          data-testid="cal-huangli-toggle"
        />
      ) : null}
      <div className={styles.hlDate} aria-hidden={toggle || undefined}>
        <div className={styles.hlDay}>{h.day}</div>
        <div className={styles.hlYear}>{t('cal.hl.year', { gz: h.yearGz, m: h.month })}</div>
      </div>
      <div className={styles.hlRows}>
        <div className={styles.hlRow} data-testid="cal-huangli-yi">
          <span className={`${styles.hlTag} ${styles.hlYi}`}>{t('cal.hl.yi', {})}</span>
          <Items ws={h.yi} t={t} at={yi} />
        </div>
        <div className={styles.hlRow} data-testid="cal-huangli-ji">
          <span className={`${styles.hlTag} ${styles.hlJi}`}>{t('cal.hl.ji', {})}</span>
          <Items ws={h.ji} t={t} at={ji} />
        </div>
      </div>
    </div>
  );
}

/** 加载黄历时先占好卡片的位置（同样的版面、不画字），加载完换成卡片不跳（R-431 独立评审第 7 条） */
export function HuangliHold() {
  return (
    <div className={styles.hl} aria-hidden="true" data-testid="cal-huangli-wait">
      <div className={styles.hlDate}>
        <div className={styles.hlDay}>{' '}</div>
        <div className={styles.hlYear}>{' '}</div>
      </div>
      <div className={styles.hlRows}>
        <div className={styles.hlRow}>
          <span className={styles.hlTag} />
        </div>
        <div className={styles.hlRow}>
          <span className={styles.hlTag} />
        </div>
      </div>
    </div>
  );
}
