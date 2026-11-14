// 结果层（B4b-3；架构 5.14 第 2～4、7 点；按确认线框“22 按＋：记下、查找、总结”R-116 对齐，返工 11-14）
// • 顶部：左上“✕ 关闭”、中间标题“查找结果”，下一行灰字引号写原话；打开时焦点给面板本身（不落在“关闭”上画黑框），Tab 进去照样有焦点环
// • “理解成：…”一整条浅底行，右边“改”（req.edit：回打字条，原话带回去改；没有原话的不出）
// • 时间类查找：按日子分组精确列出（本机缓存）；“没有截止日期的待办不在里面”；截止到今天的写过期条数，过期的标红
// • 总结：意图是总结时打开就总结；查找时页脚“总结一下”。总结卡带边框，小字标题“AI 总结 · 只显示，不保存”；正文纯文本（A22、A26），
//   服务器改写好的 [m] 画成小号角标（m 是 cited 里第几条）；底部“依据：N 条记录”加“收起 / 展开”，展开是编号列表，序号和角标对应，
//   没引用的也列出来（不编号、写“没引用”），点一条打开那条；“N 条还没同步，没算进总结”
// • 页脚：“这次用了 N 次 AI（判断 x 次、总结 y 次）· 今天 已用 / 上限”；今天的用量读不到就只写前半句
// • 取消、改期、完成：候选每条一个按钮（批量改期默认全勾、一个按钮）；没候选写“没找到对应的条目”加“去日历里找”；
//   泛指词的取消、标完成写“请在列表里操作”；写完出“已取消：…”和“撤销”；说了“相关待办”加一句“相关的待办请在列表里删”
// • 底部永远有“改成记下”（取消改期完成叫“都不是 · 按原话记下”，req.record 为 null 时不出：从提示条打开的已经存过了）和“关掉”
// • 焦点锁定、Esc、读屏标注用 Radix Dialog（同 FindPanel），滚动锁 useScrollLock
// • 运行日志：assist open / close（意图、从哪来、开了多久）、assist record；数据那边的见 hooks/useAssist.ts
import * as RD from '@radix-ui/react-dialog';
import { useEffect, useRef, useState, type ReactNode } from 'react';
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
import { Lead, metaOf, openItem, useFindT, whenText, type T } from './find-parts.tsx';

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

/** 总结正文：[m]（m 在 1..n 之内）画成小号角标，别的照原文 */
function withCites(text: string, n: number): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(/\[(\d+)\]/g)) {
    const k = Number(m[1]);
    if (k < 1 || k > n) continue;
    out.push(text.slice(at, m.index), <sup key={`c${m.index}`} className={a.sup} data-testid="assist-cite">{k}</sup>);
    at = m.index + m[0].length;
  }
  out.push(text.slice(at));
  return out;
}

/** 改期按钮上的“11/10 周二 15:00” */
const toText = (h: TargetHit, to: { date: string | null; time: string | null } | null, today: string, locale: Locale): string => {
  const m = moveTo(h, to ?? { date: null, time: null }, today);
  return whenText(m.date, m.time, locale);
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
  const edit = req.edit;
  const onEdit = edit === null ? null : (): void => {
    // 先交出去再关：plus 那边记下“改了”，关掉时就不清草稿
    edit();
    onClose();
  };
  const [basisOpen, setBasisOpen] = useState(true);
  const content = useRef<HTMLDivElement>(null);

  // 用了几次 AI：判断（plus 交来的 aiUsed）+ 总结（成功才算，失败服务器退回次数）；今天的用量读到了才接后半句
  const judgeN = req.aiUsed;
  const sumN = s.sum.s === 'done' ? 1 : 0;
  const aiN = judgeN + sumN;
  const aiText = aiN === 0 ? '' : judgeN > 0 && sumN > 0 ? t('as.ai2', { n: aiN, j: judgeN, s: sumN }) : t('as.ai', { n: aiN });
  const usageText = aiText === '' ? '' : [aiText, s.usage ? t('as.today', { used: s.usage.used, limit: s.usage.limit }) : ''].filter(Boolean).join(' · ');

  const done = (it: FindItem): boolean => it.kind === 'todo' && it.done;
  /** num：依据列表里的序号（和正文角标对应）；0 是没引用的，不编号、第二行写“没引用”；undefined 是普通列表，不留序号那一格 */
  const row = (it: FindItem, num?: number): ReactNode => (
    <li key={`${it.kind}:${it.id}`}>
      <button type="button" className={styles.row} onClick={() => pick(it)} data-testid="assist-row" data-kind={it.kind} data-cited={num ? '1' : undefined} data-done={done(it) || undefined}>
        {num === undefined ? null : <span className={a.num} data-testid="assist-num">{num || ''}</span>}
        <Lead kind={it.kind} done={done(it)} />
        <span className={styles.text}>
          <span className={`${styles.title} ${it.kind === 'todo' && !it.done && it.date !== null && it.date < s.today ? a.late : ''}`}>{it.title || t('find.noTitle', {})}</span>
          <span className={styles.meta}>{metaOf({ item: it, score: 0, snippet: null }, t, locale)}{num === 0 ? t('as.sum.uncited', {}) : ''}</span>
        </span>
      </button>
    </li>
  );

  let body: ReactNode;
  let understand = '';
  if ('query' in req.ask) {
    const q = req.ask.query;
    understand = understandQuery(req, t, locale, s.overdue);
    // 总结好了：依据列表按 cited 的顺序编号（第 m 个就是正文里的角标 m），没引用的排在后面
    const cited = s.sum.s === 'done' ? s.sum.cited : null;
    const numOf = (it: FindItem): number => {
      if (cited === null) return 0;
      const i = cited.indexOf(it.id);
      const j = i < 0 && it.noteId !== null ? cited.indexOf(it.noteId) : i;
      return j + 1;
    };
    const basis = cited === null ? [] : s.items.map((it) => ({ it, n: numOf(it) })).sort((x, y) => (x.n || Infinity) - (y.n || Infinity));
    const sum = !sumAsked ? null : (
      <section className={a.sum} aria-live="polite" data-testid="assist-summary" data-state={s.sum.s}>
        <div className={a.sumHead}>{t('as.sum.head', {})}</div>
        {s.sum.s === 'wait' ? <p className={a.sumText}>{t('as.sum.wait', {})}</p> : null}
        {s.sum.s === 'done' ? (
          <>
            <p className={a.sumText} data-testid="assist-summary-text">{withCites(s.sum.summary, s.sum.cited.length)}</p>
            {s.sum.missing > 0 ? <p className={a.note}>{t('as.sum.missing', { n: s.sum.missing })}</p> : null}
            <div className={a.basisBar}>
              <span>{t('as.sum.basis', { n: basis.length })}</span>
              <button type="button" className={a.fold} aria-expanded={basisOpen} aria-controls="assist-basis" onClick={() => setBasisOpen((v) => !v)} data-testid="assist-basis-toggle">
                {t(basisOpen ? 'as.sum.fold' : 'as.sum.unfold', {})} <span aria-hidden="true">{basisOpen ? '▴' : '▾'}</span>
              </button>
            </div>
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
    ) : cited !== null ? (
      basisOpen ? <ul className={`${styles.list} ${a.basis}`} id="assist-basis" data-testid="assist-basis">{basis.map((b) => row(b.it, b.n))}</ul> : null
    ) : q.range !== null ? (
      byDay(s.items).map((g) => (
        <section key={g.date} aria-label={fmtDay(g.date, locale, 'monthDayWeek')} data-testid="assist-day">
          <div className={styles.gh}><b>{fmtDay(g.date, locale, 'monthDayWeek')}</b></div>
          <ul className={styles.list}>{g.items.map((it) => row(it))}</ul>
        </section>
      ))
    ) : (
      <ul className={styles.list}>{s.items.map((it) => row(it))}</ul>
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

  const showSum = 'query' in req.ask && !sumAsked && s.items.length > 0;
  const showRec = 'query' in req.ask && asRecord !== null;
  const footer = (
    <>
      {showSum || showRec ? (
        <div className={a.acts}>
          {showSum ? (
            <button type="button" className={`${a.act} ${a.actMain}`} onClick={() => { setSumAsked(true); s.summarize(); }} data-testid="assist-summarize">{t('as.sum.btn', {})}</button>
          ) : null}
          {showRec ? <button type="button" className={a.act} onClick={asRecord ?? undefined} data-testid="assist-record">{t('as.record', {})}</button> : null}
        </div>
      ) : null}
      {usageText ? <p className={a.usage} data-testid="assist-usage">{usageText}</p> : null}
    </>
  );

  const said = req.raw || ('query' in req.ask ? req.ask.query.text : req.ask.target.text);

  return (
    <RD.Root open onOpenChange={(o) => (o ? undefined : onClose())}>
      <RD.Portal>
        {desk ? <div className={styles.scrim} onClick={onClose} aria-hidden="true" /> : null}
        <RD.Content
          ref={content}
          className={desk ? `${styles.desk} ${a.panel}` : styles.phone}
          aria-describedby={undefined}
          // 打开时焦点给面板本身（Radix 默认给第一个按钮“关闭”，读屏和键盘照样从这里开始，但手机上会画出一圈黑框）
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            content.current?.focus({ preventScroll: true });
          }}
          data-testid="assist-panel"
          data-intent={req.ask.intent}
        >
          <PanelHead t={t} desk={desk} said={said} understand={understand} onClose={onClose} onEdit={onEdit} />
          <div className={desk ? `${styles.body} ${a.deskBody}` : styles.body}>
            {body}
            {footer}
          </div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

/** 顶部：“✕ 关闭”、标题、原话；“理解成：…”一整条加“改”（线框 22 RESH、UNDERSTOOD） */
function PanelHead({ t, desk, said, understand, onClose, onEdit }: { t: T; desk: boolean; said: string; understand: string; onClose(): void; onEdit: (() => void) | null }) {
  // 词条里 {x} 的位置因语言而不同：拆开以后把 x 加粗
  const [pre = '', post = ''] = t('as.understand', { x: '\u0001' }).split('\u0001');
  return (
    <>
      <div className={desk ? `${a.top} ${a.deskPad}` : a.top}>
        <button type="button" className={a.close} onClick={onClose} data-testid="assist-close"><span aria-hidden="true">✕ </span>{t('find.close', {})}</button>
        <RD.Title className={a.title}>{t('find.results', {})}</RD.Title>
        <span aria-hidden="true" />
      </div>
      {said ? <p className={desk ? `${a.said} ${a.deskPad}` : a.said} data-testid="assist-said">“{said}”</p> : null}
      {understand ? (
        <div className={desk ? `${a.und} ${a.deskMx}` : a.und}>
          <span className={a.undText} data-testid="assist-understand">{pre}<b>{understand}</b>{post}</span>
          {onEdit ? <button type="button" className={a.edit} onClick={onEdit} data-testid="assist-edit">{t('as.edit', {})}</button> : null}
        </div>
      ) : null}
    </>
  );
}

type S = ReturnType<typeof useAssist>;

function targetUnderstand(req: AssistReq, s: S, t: T, locale: Locale): string {
  if (!('target' in req.ask)) return '';
  const g = req.ask.target;
  const when = g.date ? whenText(g.date, g.time, locale) : '';
  const text = g.text || t('as.t.any', {});
  const what = when ? t('as.t.what', { when, text }) : text;
  if (req.ask.intent === 'cancel') return t('as.t.cancel', { what });
  if (req.ask.intent === 'complete') return t('as.t.complete', { what });
  const first = s.match.hits[0];
  const to = req.ask.to;
  const toLabel = first ? toText(first, to, s.today, locale) : whenText(to?.date, to?.time, locale);
  return t('as.t.reschedule', { what, to: toLabel });
}

function TargetCard({ req, s, t, locale, onRecord, onClose }: { req: AssistReq; s: S; t: T; locale: Locale; onRecord: (() => void) | null; onClose(): void }) {
  if (!('target' in req.ask)) return null;
  const ask = req.ask;
  const titleOf = (h: TargetHit): string => s.titleOf(h.id) || t('find.noTitle', {});
  const meta = (h: TargetHit): string => whenText(h.date, h.time, locale);
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
