// “现在”卡（皮肤视觉稿方案 K 小时间尺，R-131、R-133；状态照 R-118；R-423 起所有状态都是同一张大卡）
// 数都在 data/today-model.ts 的 nowCard 里算好（墙上时刻、时间尺位置、剩几分钟），这里只按状态查表、拼文案：
// • live：页头“进行中”（两件以上“进行中 N 件”）+“现在 14:17”+“还剩 13 分钟”；标题是最先结束的那件（加粗，R-134）；
//   第二件写一行“同时：… · 到 15:00 · 还剩 43 分钟”，三件及以上“同时还有 N 件”；时间尺第二件画在第二条轨道（视觉稿 kRuler 最多两条）
// • idle：页头“下一件”+“1 小时 13 分后”，标题“开始时刻 标题”
// • far（下一件在时间尺外）、done（今天的都结束了）、allday（只有全天的）、empty（今天没有日程）：标题行写暖心句
//   （负责人 11-14：“没有日程的时候可以显示一些鼓励的句子或者暖心句子”；11-15：“跟有日程的时候一样的样式！不是一个小框加一句话”），
//   照样画此刻前后的时间尺；far 在时间尺下面写一次“下一件 17:00 逛街 · 4 小时 21 分后”，done 有明天第一件时写“明天 11:00 …”
// 暖心句按用户时区的当天日期固定选一句（useCheerText，按语言懒加载）；句子下载好之前这一行是空的，CSS 留一行高（.cheer:empty），卡片不跳
// 时间尺只是示意（aria-hidden），读屏靠页头和标题行的文字；进行中、下一件又在时间尺里时，另给读屏一句“下一件 …”（看得见的只有尺上的色块）
// 时间尺照视觉稿 kRuler：第二件（co）用自己的 --k-co 色；下一件左边竖条是项目色；磨砂玻璃皮肤的当前事项是 8px 胶囊、此刻是带圈圆头（样式里按皮肤分）
import { useEffect, type CSSProperties, type ReactNode } from 'react';
import refine from '../../../kit/components/Refine.module.css';
import { rlog } from '../../../platform/run-log-api.ts';
import type { DateStr } from '../../../../shared/core/date.ts';
import type { NowCard as Card, NowSeg, NowState } from '../hooks/today-types.ts';
import { durText, useCheerText, useLocale, useTodayT } from '../hooks/useTodayT.ts';
import styles from './NowCard.module.css';

type T = ReturnType<typeof useTodayT>;

/** 数字段换等宽（R-436 丁批：“现在 10:21”、时长“1 小时 13 分”里的数字，照 kit NumIn 的做法只包数字、整句字体不换）。
 *  词条整句照旧翻译：要换等宽的参数先用 num() 包上记号，show() 再把记号里的数字包成 Refine.module.css 的 .num；标题等用户写的字不包、原样输出 */
const num = (v: string | number): string => `${v}`;   // 私用区字符当记号，词条和用户的字里不会出现
function show(s: string): ReactNode {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of s.matchAll(/([^]*)/g)) {
    out.push(s.slice(at, m.index));
    for (const d of (m[1] ?? '').matchAll(/\d+(?::\d+)?|\D+/g)) {
      // key 用它在整句里的位置（同一句里不会重）
      out.push(/^\d/.test(d[0]) ? <span key={m.index + d.index} className={refine.num}>{d[0]}</span> : d[0]);
    }
    at = m.index + m[0].length;
  }
  out.push(s.slice(at));
  return out;
}

/** 每种状态的页头标签 */
const LABEL: Record<NowState, (c: Card, t: T) => string> = {
  live: (c, t) => (c.liveN > 1 ? t('now.live2', { n: num(c.liveN) }) : t('now.live', {})),
  idle: (_, t) => t('now.idle', {}),
  far: (_, t) => t('now.idle', {}),
  done: (_, t) => t('now.done', {}),
  allday: (c, t) => (c.allDay && c.allDay.n > 1 ? t('now.allDayN', { n: num(c.allDay.n) }) : t('now.allDay', { title: c.allDay?.title ?? '' })),
  empty: (_, t) => t('now.empty', {}),
};

/** 一条轨道 20px，两条各 13px、中间隔 4px（视觉稿 kRuler） */
const LANE = { 1: { h: 20, gap: 0 }, 2: { h: 13, gap: 4 } } as const;

export function NowCard({ card, today }: { card: Card; today: DateStr }) {
  const t = useTodayT();
  const locale = useLocale();
  const cheer = useCheerText(today, locale);
  const live = card.state === 'live';
  // 运行日志：卡片换状态时记一行（负责人 11-14 说“框没做”，日志里看不出当时是哪种卡）
  useEffect(() => {
    rlog(`today now state=${card.state} cheer=${cheer ? 1 : 0}`);
  }, [card.state, cheer]);

  const lane = LANE[card.ruler.lanes];
  const lh = card.ruler.lanes * lane.h + (card.ruler.lanes - 1) * lane.gap;
  const pct = (x: number) => `${x * 100}%`;
  const seg = (s: NowSeg) => (
    <span
      key={`${s.kind}-${s.id}`}
      data-kind={s.kind}
      className={`${styles.seg} ${styles[s.kind]} ${s.clipL ? styles.cl : ''} ${s.clipR ? styles.cr : ''}`}
      style={
        {
          left: pct(s.x0),
          width: pct(s.x1 - s.x0),
          '--t': `${4 + s.lane * (lane.h + lane.gap)}px`,
          '--h': `${lane.h}px`,
          '--pc': s.pc ? `var(--p${s.pc}s)` : 'var(--k-fg2)',
        } as CSSProperties
      }
    >
      {s.kind === 'nxt' ? (
        <>
          <b className={styles.bar} />
          <span className={styles.lb}>{s.label}</span>
        </>
      ) : (
        <i className={styles.fill} style={{ width: pct(s.done) }} />
      )}
    </span>
  );

  return (
    <section className={styles.card} data-testid="now-card" data-state={card.state}>
      <p className={styles.head}>
        <span className={live ? styles.labelLive : styles.labelIdle}>
          <i className={styles.dot} />
          <span className={styles.labelText}>{show(LABEL[card.state](card, t))}</span>
        </span>
        <span className={styles.nowText}>{show(t('now.now', { t: num(card.nowText) }))}</span>
        {card.left !== null ? (
          <span className={styles.left} data-testid="now-left">
            {show(live ? t('now.left', { d: num(durText(card.left, locale)) }) : t('now.in', { d: num(durText(card.left, locale)) }))}
          </span>
        ) : null}
      </p>
      {card.title !== null ? (
        <p className={live ? styles.titleLive : styles.title} data-testid="now-title">
          {card.time !== null ? <span className={styles.num}>{card.time} </span> : null}
          {card.title}
        </p>
      ) : (
        <p className={`${styles.title} ${styles.cheer}`} data-testid="now-cheer">
          {cheer}
        </p>
      )}
      {card.also ? (
        <p className={styles.sub} data-testid="now-also">
          {'more' in card.also
            ? show(t('now.alsoMore', { n: num(card.also.more) }))
            : show(t('now.also', { title: card.also.title, end: num(card.also.end), d: num(durText(card.also.left, locale)) }))}
        </p>
      ) : null}
      {live && card.next && card.foot === null ? (
        <span className={styles.srOnly}>{t('now.hint', { t: card.next.time, title: card.next.title, d: durText(card.next.inMin, locale) })}</span>
      ) : null}
      <div className={`${styles.ruler} ${card.ruler.lanes === 2 ? styles.two : ''}`} aria-hidden="true" data-testid="now-ruler" data-lanes={card.ruler.lanes} style={{ '--lh': `${lh}px` } as CSSProperties}>
        {card.ruler.trk.map((k) => (
          <span
            key={k.x0}
            className={styles.trk}
            style={{ left: k.gapL ? `calc(${pct(k.x0)} + 3px)` : pct(k.x0), right: k.gapR ? `calc(${pct(1 - k.x1)} + 3px)` : pct(1 - k.x1) }}
          />
        ))}
        {card.ruler.segs.map(seg)}
        <span className={styles.mark} style={{ left: pct(card.ruler.mark) }} />
        {card.ruler.ticks.map((k) => (
          <span key={k.x} className={`${styles.tick} ${k.edge === 'l' ? styles.tl : k.edge === 'r' ? styles.tr : ''}`} style={{ left: pct(k.x) }}>
            {k.text}
          </span>
        ))}
      </div>
      {card.foot?.kind === 'next' ? (
        <p className={styles.sub} data-testid="now-hint">
          {show(t('now.hint', { t: num(card.foot.time), title: card.foot.title, d: num(durText(card.foot.inMin, locale)) }))}
        </p>
      ) : card.foot?.kind === 'tomorrow' ? (
        <p className={styles.sub} data-testid="now-tomorrow">
          {show(t('now.doneNext', { t: num(card.foot.time), title: card.foot.title }))}
        </p>
      ) : null}
    </section>
  );
}
