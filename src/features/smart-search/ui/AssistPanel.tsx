// 结果层（B4b-3；架构 5.14 第 2～4、7 点；样式同查找面板 s12、sFind，“理解成：…”一行写在顶上）
// • 时间类查找：按日子分组精确列出（本机缓存）；“没有截止日期的待办不在里面”；截止到今天的写过期条数，过期的标红
// • 总结：意图是总结时打开就总结；查找时页脚“总结一下”。总结文字纯文本显示（A22、A26），下面列出全部依据，cited 里的标出来；
//   “N 条还没同步，没算进总结”；页脚写“这次用了 N 次 AI”
// • 取消、改期、完成：候选每条一个按钮（批量改期默认全勾、一个按钮）；没候选写“没找到对应的条目”加“去日历里找”；
//   泛指词的取消、标完成写“请在列表里操作”；写完出“已取消：…”和“撤销”；说了“相关待办”加一句“相关的待办请在列表里删”
// • 底部永远有“改成记下”（取消改期完成叫“都不是 · 按原话记下”，req.record 为 null 时不出：从提示条打开的已经存过了）和“关掉”
// • 焦点锁定、Esc、读屏标注用 Radix Dialog（同 FindPanel），滚动锁 useScrollLock
// • 运行日志：assist open / close（意图、从哪来、开了多久）、assist record；数据那边的见 hooks/useAssist.ts
import * as RD from '@radix-ui/react-dialog';
import { useEffect, useState, type ReactNode } from 'react';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import { navigate } from '../../../app/router.ts';
import { useScrollLock } from '../../../kit/components/Dialog.tsx';
import { MQ_SIDEBAR, useMedia } from '../../../kit/hooks/useMedia.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { SUMMARY_MAX_ITEMS } from '../../../../shared/schema/summarize.ts';
import type { AssistReq } from '../hooks/find-open.ts';
import { byDay, moveTo, useAssist, type FindItem, type TargetHit } from '../hooks/useAssist.ts';
import a from './AssistPanel.module.css';
import styles from './FindPanel.module.css';
import { Lead, metaOf, openItem, useFindT, type T } from './find-parts.tsx';

type Locale = 'zh-CN' | 'ko-KR';

/** “理解成：…”（查找、总结） */
function understandQuery(req: AssistReq, t: T, locale: Locale, overdue: number): string {
  if (!('query' in req.ask)) return '';
  const q = req.ask.query;
  const day = (d: string) => fmtDay(d, locale, 'monthDayWeek');
  const kinds = (q.kinds.length > 0 ? q.kinds : (['event', 'todo', 'note'] as const)).map((k) => t(`as.k.${k}`, {})).join(t('as.and', {}));
  if (q.range === null) return t('as.q.text', { q: q.text, kinds });
  if (q.range.from === null) return t('as.q.until', { d: day(q.range.to), n: overdue });
  const when = q.range.from === q.range.to ? day(q.range.from) : t('as.span', { a: day(q.range.from), b: day(q.range.to) });
  return t('as.q.range', { when, kinds });
}

/** 改期按钮上的“11/10 周二 15:00” */
const toText = (h: TargetHit, to: { date: string | null; time: string | null } | null, today: string, locale: Locale): string => {
  const m = moveTo(h, to ?? { date: null, time: null }, today);
  return [fmtDay(m.date, locale, 'monthDayWeek'), m.time ?? ''].filter(Boolean).join(' ');
};

export default function AssistPanel({ req, onClose }: { req: AssistReq; onClose(): void }) {
  const t = useFindT();
  const locale = useUi((s) => s.locale);
  const desk = useMedia(MQ_SIDEBAR);
  const s = useAssist(req.ask, req.exclude);
  const [sumAsked, setSumAsked] = useState(req.ask.intent === 'summarize');
  useScrollLock(true);
  useEffect(() => {
    const t0 = clock.now();
    rlog(`assist open intent=${req.ask.intent} from=${req.from} ai=${req.aiUsed} raw=${req.raw === '' ? 0 : 1}`);
    return () => rlog(`assist close ms=${clock.now() - t0}`);
  }, [req]);

  const record = req.record;
  const asRecord = record === null ? null : (): void => {
    rlog(`assist record intent=${req.ask.intent}`);
    // 先交出去再关：关掉时 plus 清草稿，记下那边存好了也清，两边谁先都一样
    void record();
    onClose();
  };
  const pick = (it: FindItem): void => {
    onClose();
    openItem(it);
  };
  const aiN = req.aiUsed + (s.sum.s === 'done' ? 1 : 0);

  const row = (it: FindItem, cited: boolean): ReactNode => (
    <li key={`${it.kind}:${it.id}`}>
      <button type="button" className={`${styles.row} ${cited ? a.cited : ''}`} onClick={() => pick(it)} data-testid="assist-row" data-kind={it.kind} data-cited={cited ? '1' : undefined}>
        <Lead kind={it.kind} />
        <span className={styles.text}>
          <span className={`${styles.title} ${it.kind === 'todo' && !it.done && it.date !== null && it.date < s.today ? a.late : ''}`}>{it.title || t('find.noTitle', {})}</span>
          <span className={styles.meta}>{metaOf({ item: it, score: 0, snippet: null }, t, locale)}</span>
        </span>
      </button>
    </li>
  );

  const cited = s.sum.s === 'done' ? s.sum.cited : null;
  const isCited = (it: FindItem): boolean => cited !== null && (cited.has(it.id) || (it.noteId !== null && cited.has(it.noteId)));

  let body: ReactNode;
  let understand = '';
  if ('query' in req.ask) {
    const q = req.ask.query;
    understand = understandQuery(req, t, locale, s.overdue);
    const sum = !sumAsked ? null : (
      <section className={a.sum} aria-live="polite" data-testid="assist-summary" data-state={s.sum.s}>
        <div className={styles.gh}><b>{t('as.sum.head', {})}</b></div>
        {s.sum.s === 'wait' ? <p className={a.sumText}>{t('as.sum.wait', {})}</p> : null}
        {s.sum.s === 'done' ? (
          <>
            <p className={a.sumText} data-testid="assist-summary-text">{s.sum.summary}</p>
            {s.sum.missing > 0 ? <p className={a.note}>{t('as.sum.missing', { n: s.sum.missing })}</p> : null}
          </>
        ) : null}
        {s.sum.s === 'fail' ? (
          <p className={a.note} data-testid="assist-summary-fail" data-reason={s.sum.reason}>
            {t(`as.sum.fail.${s.sum.reason}`, {})}
            {s.sum.reason === 'failed' ? <button type="button" className={styles.link} onClick={s.summarize}>{t('as.sum.retry', {})}</button> : null}
          </p>
        ) : null}
        {s.sum.s === 'idle' && s.items.length === 0 ? <p className={a.note}>{t('as.sum.empty', {})}</p> : null}
        {s.items.length > SUMMARY_MAX_ITEMS && s.sum.s === 'done' ? <p className={a.note}>{t('as.sum.more', { max: SUMMARY_MAX_ITEMS })}</p> : null}
      </section>
    );
    const list = s.items.length === 0 ? (
      <div className={styles.empty} data-testid="assist-empty"><div className={styles.emptyT}>{t('as.empty', {})}</div></div>
    ) : q.range !== null ? (
      byDay(s.items).map((g) => (
        <section key={g.date} aria-label={fmtDay(g.date, locale, 'monthDayWeek')} data-testid="assist-day">
          <div className={styles.gh}><b>{fmtDay(g.date, locale, 'monthDayWeek')}</b></div>
          <ul className={styles.list}>{g.items.map((it) => row(it, isCited(it)))}</ul>
        </section>
      ))
    ) : (
      <>
        {sumAsked ? <div className={styles.gh}><b>{t('as.sum.basis', { n: s.items.length })}</b></div> : null}
        <ul className={styles.list}>{s.items.map((it) => row(it, isCited(it)))}</ul>
      </>
    );
    body = (
      <>
        {q.range !== null && q.kinds.includes('todo') && q.range.from !== null ? <p className={a.note}>{t('as.noDue', {})}</p> : null}
        {sum}
        {list}
      </>
    );
  } else {
    body = <TargetCard req={req} s={s} t={t} locale={locale} onRecord={asRecord} onClose={onClose} />;
    understand = targetUnderstand(req, s, t, locale);
  }

  const footer = (
    <div className={a.foot}>
      {'query' in req.ask && !sumAsked && s.items.length > 0 ? (
        <button type="button" className={styles.chip} onClick={() => { setSumAsked(true); s.summarize(); }} data-testid="assist-summarize">{t('as.sum.btn', {})}</button>
      ) : null}
      {'query' in req.ask && asRecord ? (
        <button type="button" className={styles.chip} onClick={asRecord} data-testid="assist-record">{t('as.record', {})}</button>
      ) : null}
      {aiN > 0 ? <span className={a.note}>{t('as.ai', { n: aiN })}</span> : null}
    </div>
  );

  return (
    <RD.Root open onOpenChange={(o) => (o ? undefined : onClose())}>
      <RD.Portal>
        {desk ? <div className={styles.scrim} onClick={onClose} aria-hidden="true" /> : null}
        <RD.Content className={`${desk ? styles.desk : styles.phone} ${a.panel}`} aria-describedby={undefined} data-testid="assist-panel" data-intent={req.ask.intent}>
          <RD.Title className={styles.sr}>{t('find.results', {})}</RD.Title>
          <div className={styles.head}>
            <div className={styles.field}>
              <span className={styles.plus} aria-hidden="true">＋</span>
              <span className={a.said}>{req.raw || ('query' in req.ask ? req.ask.query.text : req.ask.target.text)}</span>
            </div>
            <button type="button" className={styles.close} onClick={onClose} data-testid="assist-close">{t('find.close', {})}</button>
          </div>
          {understand ? <p className={desk ? `${a.und} ${a.deskPad}` : a.und} data-testid="assist-understand">{t('as.understand', { x: understand })}</p> : null}
          <div className={desk ? `${styles.body} ${a.deskBody}` : styles.body}>
            {body}
            {footer}
          </div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

type S = ReturnType<typeof useAssist>;

function targetUnderstand(req: AssistReq, s: S, t: T, locale: Locale): string {
  if (!('target' in req.ask)) return '';
  const g = req.ask.target;
  const when = g.date ? [fmtDay(g.date, locale, 'monthDayWeek'), g.time ?? ''].filter(Boolean).join(' ') : '';
  const text = g.text || t('as.t.any', {});
  const what = when ? t('as.t.what', { when, text }) : text;
  if (req.ask.intent === 'cancel') return t('as.t.cancel', { what });
  if (req.ask.intent === 'complete') return t('as.t.complete', { what });
  const first = s.match.hits[0];
  const to = req.ask.to;
  const toLabel = first ? toText(first, to, s.today, locale) : [to?.date ? fmtDay(to.date, locale, 'monthDayWeek') : '', to?.time ?? ''].filter(Boolean).join(' ');
  return t('as.t.reschedule', { what, to: toLabel });
}

function TargetCard({ req, s, t, locale, onRecord, onClose }: { req: AssistReq; s: S; t: T; locale: Locale; onRecord: (() => void) | null; onClose(): void }) {
  if (!('target' in req.ask)) return null;
  const ask = req.ask;
  const titleOf = (h: TargetHit): string => s.titleOf(h.id) || t('find.noTitle', {});
  const meta = (h: TargetHit): string => [h.date ? fmtDay(h.date, locale, 'monthDayWeek') : '', h.time ?? ''].filter(Boolean).join(' ');
  const batch = ask.intent === 'reschedule' && ask.target.all === true;
  const chosen = s.match.hits.filter((h) => !s.off.has(h.id));
  const go = async (hs: TargetHit[]): Promise<void> => {
    const r = await s.confirm(hs);
    if (r && r.ok > 0) await req.undoSaved?.();
  };
  const tail = (
    <div className={a.foot}>
      {onRecord ? <button type="button" className={styles.chip} onClick={onRecord} data-testid="assist-record">{t('as.recordRaw', {})}</button> : null}
      <button type="button" className={styles.chip} onClick={onClose} data-testid="assist-dismiss">{t('as.close', {})}</button>
      {req.aiUsed > 0 ? <span className={a.note}>{t('as.ai', { n: req.aiUsed })}</span> : null}
    </div>
  );

  if (s.act.s === 'done' || s.act.s === 'undone') {
    const ap = s.act.s === 'done' ? s.act.a : null;
    const one = s.match.hits.find((h) => ap?.undo.some((u) => u.id === h.id));
    const toL = one && ask.intent === 'reschedule' ? toText(one, ask.to, s.today, locale) : '';
    const msg = s.act.s === 'undone' ? t('as.undone', {})
      : ap && ap.ok === 1 && one ? t(`as.t.ok.${ask.intent}`, { t: titleOf(one), to: toL })
      : t(`as.t.okN.${ask.intent}`, { n: ap?.ok ?? 0, to: toL });
    return (
      <div data-testid="assist-target-done">
        <p className={a.done} role="status">
          {msg}
          {ap && ap.undo.length > 0 ? <button type="button" className={styles.link} onClick={() => void s.undo()} data-testid="assist-undo">{t('find.undo', {})}</button> : null}
        </p>
        {ap && ap.failed > 0 ? <p className={a.note}>{t('as.t.failed', { n: ap.failed })}</p> : null}
        {ask.relatedTodos ? <p className={a.note}>{t('as.t.related', {})}</p> : null}
      </div>
    );
  }
  if (ask.bulkRefused) return <div data-testid="assist-target-bulk"><p className={a.note}>{t('as.t.bulk', {})}</p>{tail}</div>;
  if (s.match.hits.length === 0) {
    return (
      <div data-testid="assist-target-none">
        <div className={styles.empty}><div className={styles.emptyT}>{t('as.t.none', {})}</div></div>
        <div className={a.foot}>
          <button type="button" className={styles.chip} onClick={() => { onClose(); void navigate('calendar'); }} data-testid="assist-go-cal">{t('as.t.goCal', {})}</button>
        </div>
        {tail}
      </div>
    );
  }
  const busy = s.act.s === 'busy';
  return (
    <div data-testid="assist-target">
      {ask.relatedTodos ? <p className={a.note}>{t('as.t.related', {})}</p> : null}
      <ul className={styles.list}>
        {s.match.hits.map((h) => (
          <li key={h.id} className={a.cand} data-testid="assist-cand">
            {batch ? (
              <input type="checkbox" className={a.check} checked={!s.off.has(h.id)} onChange={() => s.toggle(h.id)} aria-label={titleOf(h)} data-testid="assist-cand-check" />
            ) : null}
            <Lead kind={h.kind} />
            <span className={styles.text}>
              <span className={styles.title}>{titleOf(h)}</span>
              <span className={styles.meta}>{meta(h)}</span>
            </span>
            {batch ? null : (
              <button type="button" className={styles.chipOn} disabled={busy} onClick={() => void go([h])} data-testid="assist-cand-act">
                {ask.intent === 'reschedule' ? t('as.t.btn.reschedule', { to: toText(h, ask.to, s.today, locale) }) : t(`as.t.btn.${ask.intent}`, {})}
              </button>
            )}
          </li>
        ))}
      </ul>
      {s.match.more > 0 ? <p className={a.note}>{t('as.t.more', { n: s.match.more })}</p> : null}
      {batch ? (
        <div className={a.foot}>
          <button type="button" className={styles.chipOn} disabled={busy || chosen.length === 0} onClick={() => void go(chosen)} data-testid="assist-batch-act">
            {t('as.t.btnAll', { to: s.match.hits[0] ? toText(s.match.hits[0], ask.to, s.today, locale) : '', n: chosen.length })}
          </button>
        </div>
      ) : null}
      {tail}
    </div>
  );
}
