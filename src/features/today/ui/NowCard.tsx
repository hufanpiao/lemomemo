// “现在”卡（皮肤视觉稿方案 K 小时间尺，R-131、R-133；状态 ①～④ 照 R-118）
// ① 进行中：“● 进行中”（两件以上“进行中 N 件”）+“现在 14:17”+“还剩 13 分钟”；标题是最先结束的那件（加粗，R-134 允许）；
//    同时进行的第二件写一行“同时：… · 到 15:00 · 还剩 43 分钟”，三件及以上写“同时还有 N 件”
// ② 没有进行中：“○ 下一件”+“1 小时 13 分后”；标题写“开始时间 + 标题”。
//    下一件在时间尺窗口外（窗口里一件都没有，负责人 11-14）：不画黄卡和空时间尺，换成浅色卡（线框 ④ emptyA 的样子，data-state="calm"）：
//    第一行暖心句，第二行“下一件 17:00 逛街 · 4 小时 21 分后”只写这一次
// 时间轴：窗口 [A, B]（分钟，相对今天 0 点）、整点刻度、正在进行的色块（已过去的部分另涂）、下一件色块、此刻竖线；
//    ① 进行中而下一件在窗口外时，时间轴下面写“下一件 15:30 … · 3 小时 10 分后”（② 的下一件在窗口外时已经走浅色卡，黄卡底下不会再重复写一遍）
// ③ 今天的日程都结束了（有明天的第一件就写“明天 11:00 …”）；④ 今天没有日程：浅色卡，写暖心句（负责人 11-14，替掉“今天没有日程”）。③ ④ 不画时间轴
// 暖心句按用户时区的当天日期固定选一句（hooks 的 useCheerText，按语言懒加载），同一天每次打开同一句；读屏照常读这一行；
// 句子下载好之前这一行是空的，CSS 给它留一行高（.quiet:empty），卡片不跳
// 时间轴只是示意（aria-hidden），读屏靠上面的文字
import { msAt, type DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import type { EventOcc, NowCard as Card } from '../hooks/today-types.ts';
import { durText, useCheerText, useLocale, useTodayT } from '../hooks/useTodayT.ts';
import styles from './NowCard.module.css';

const MIN = 60_000;
const hm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.round(min) % 60).padStart(2, '0')}`;

export function NowCard({ card, now, tz, today, tomorrowFirst }: { card: Card; now: number; tz: Tz; today: DateStr; tomorrowFirst: EventOcc | null }) {
  const t = useTodayT();
  const locale = useLocale();
  const cheer = useCheerText(today, locale);
  const zero = msAt(today, 0, tz);
  const m = (ms: number) => (ms - zero) / MIN;
  const nowM = m(now);

  if (card.state === 'done') {
    return (
      <section className={styles.card} data-testid="now-card" data-state="done">
        <p className={styles.quiet}>{t('now.done', {})}</p>
        {tomorrowFirst?.time ? <p className={styles.sub}>{t('now.doneNext', { t: tomorrowFirst.time, title: tomorrowFirst.title })}</p> : null}
      </section>
    );
  }
  if (card.state === 'empty' || (card.state === 'idle' && card.nextOutside)) {
    const next = card.state === 'idle' ? card.next : null;
    return (
      <section className={`${styles.card} ${styles.calm}`} data-testid="now-card" data-state={next ? 'calm' : 'empty'}>
        <p className={styles.quiet} data-testid="now-cheer">
          {cheer}
        </p>
        {next ? (
          <p className={styles.sub} data-testid="now-hint">
            {t('now.hint', { t: next.time ?? '', title: next.title, d: durText(Math.ceil(((next.start ?? now) - now) / MIN), locale) })}
          </p>
        ) : null}
      </section>
    );
  }

  const live = card.state === 'live';
  const first = live ? card.cur[0] : card.next;
  const second = live ? card.cur[1] : undefined;
  const next = card.next;
  const { A, B } = card.win;
  const W = B - A;
  const X = (min: number) => `${((Math.min(Math.max(min, A), B) - A) / W) * 100}%`;
  const ticks: number[] = [];
  for (let x = Math.ceil(A / 60) * 60; x <= B; x += 60) ticks.push(x);
  const seg = (o: EventOcc, kind: 'cur' | 'nxt') => {
    const s = m(o.start ?? 0);
    const e = m(o.end ?? 0);
    if (e <= A || s >= B) return null;
    const done = kind === 'cur' ? Math.max(0, Math.min(1, (nowM - Math.max(s, A)) / (Math.min(e, B) - Math.max(s, A)))) : 0;
    return (
      <span
        key={`${kind}-${o.id}`}
        className={`${styles.seg} ${kind === 'cur' ? styles.cur : styles.nxt} ${s < A ? styles.cl : ''} ${e > B ? styles.cr : ''}`}
        style={{ left: X(s), width: `calc(${X(e)} - ${X(s)})` }}
      >
        {kind === 'cur' ? <i className={styles.fill} style={{ width: `${done * 100}%` }} /> : <span className={styles.lb}>{o.project || o.title}</span>}
      </span>
    );
  };

  return (
    <section className={styles.card} data-testid="now-card" data-state={card.state}>
      <p className={styles.head}>
        <span className={live ? styles.labelLive : styles.labelIdle}>
          {live ? (card.cur.length > 1 ? t('now.live2', { n: card.cur.length }) : t('now.live', {})) : t('now.idle', {})}
        </span>
        <span className={styles.nowText}>{t('now.now', { t: hm(nowM) })}</span>
        <span className={styles.left} data-testid="now-left">
          {live ? t('now.left', { d: durText(card.leftMin, locale) }) : t('now.in', { d: durText(card.inMin, locale) })}
        </span>
      </p>
      <p className={live ? styles.titleLive : styles.title} data-testid="now-title">
        {live ? first?.title : `${first?.time ?? ''} ${first?.title ?? ''}`}
      </p>
      {live && second ? (
        <p className={styles.sub} data-testid="now-also">
          {card.cur.length > 2
            ? t('now.alsoMore', { n: card.cur.length - 1 })
            : t('now.also', { title: second.title, end: hm(m(second.end ?? 0)), d: durText(Math.ceil(((second.end ?? now) - now) / MIN), locale) })}
        </p>
      ) : null}
      <div className={styles.ruler} aria-hidden="true" data-testid="now-ruler" data-a={A} data-b={B}>
        <span className={styles.trk} />
        {live ? card.cur.slice(0, 1).map((o) => seg(o, 'cur')) : null}
        {next ? seg(next, 'nxt') : null}
        <span className={styles.mark} style={{ left: X(nowM) }} />
        {ticks.map((x) => (
          <span key={x} className={`${styles.tick} ${x === A ? styles.tl : x === B ? styles.tr : ''}`} style={{ left: X(x) }}>
            {`${Math.floor(x / 60) % 24}:00`}
          </span>
        ))}
      </div>
      {next && card.nextOutside ? (
        <p className={styles.sub} data-testid="now-hint">
          {t('now.hint', { t: next.time ?? '', title: next.title, d: durText(Math.ceil(((next.start ?? now) - now) / MIN), locale) })}
        </p>
      ) : null}
    </section>
  );
}
