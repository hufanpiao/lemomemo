// AI 回答里的“要记成这样吗”卡片（在 AI 里输入也能记日程、待办；无参考，照这个抽屉现有的 .card、.btns、依据行的记号和类型小签）：
// • 一件事一张：上面一行小字“要记成这样吗”，下面“记号 + 标题、第二行（日子时刻 · 项目）+ 类型小签”，再下面两颗按钮“记下来”“改一下”；
//   日子时刻的写法和依据行同一份（chat-parts.tsx 的 refMeta：日程“11月25日 周三 15:00”，待办“11月28日 周五截止”）；全天日程补“全天”，待办没截止日写“不设截止”
// • 过去的月日（item.confirm，同打字条“过去的日子先问”）：上面那行换成“1 月 5 日已经过了”，“记下来”换成“补记今年（1/5）”“明年（2027/1/5）”两颗
//   （日子写法 kit/confirm-dates.ts，和打字条确认行同一份），选了才出“记下来”，没选不存
// • 本机规则拿不准的（DraftWarn）：标题下面补一行小字（这天不存在没记日子 / 重复只记最近一次 / 没太有把握）
// • 记下来：useChat 的 saveCard（经 plus 交来的保存口、outbox），存着时按钮变灰写“正在记”；没存上写“没记上，再点一次”；
//   存上了按钮换成一行“✓ 已记到日程 · 查看 ›”，点了关抽屉、打开那一条（kit openRecord）
// • 改一下：不存，把整条（时长、重要、提醒、备注都在里面）经 kit/state/new-item.ts 带到现有的新建页（新建页挂上时取走、换成表单字段），关抽屉过去；回到对话卡片还是没记的样子
// • 模型交回了要记的事、本机规则一张都没拆出来（turn.draftMiss）：回答下补一行提示
import { goHref, hrefOf } from '../../../app/router.ts';
import { openRecord, RecordMark } from '../../../kit/components/RecordMark.tsx';
import { confirmDates } from '../../../kit/confirm-dates.ts';
import { setNewItem } from '../../../kit/state/new-item.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { chat, type DraftCard, type DraftWarn, type Turn } from '../hooks/useChat.ts';
import { calbarColor, kindName, refMeta, type Locale, type T } from './chat-parts.tsx';
import s from './ChatDrawer.module.css';

/** 第二行：日子时刻（同依据行）· 项目 */
export function cardMeta(c: DraftCard, today: string, t: T, locale: Locale): string {
  const it = c.item;
  const event = it.kind === 'event';
  // 日程没说日子的记今天（capture-map 同一口径）
  const date = event ? (it.date ?? today) : it.due;
  const when = refMeta({ kind: it.kind, id: '', title: it.title, date, time: it.time, done: false }, today, t, locale).text;
  const parts = [
    when === '' ? t('chat.draft.noDue', {}) : event && it.time === null ? `${when} ${t('chat.draft.allDay', {})}` : when,
    it.project ?? '',
  ];
  return parts.filter((p) => p !== '').join(' · ');
}

/** 拿不准的那一句 */
export function warnText(w: DraftWarn, t: T): string {
  switch (w.k) {
    case 'bad_day':
      return w.md ? t('chat.draft.badDay', { month: w.md.month, day: w.md.day }) : t('chat.draft.badDate', {});
    case 'recur':
      return t('chat.draft.recur', {});
    case 'unsure':
      return t('chat.draft.unsure', {});
    default: {
      const never: never = w;
      return never;
    }
  }
}

function Card({ c, i, turnId, today, t, locale, onLeave }: { c: DraftCard; i: number; turnId: number; today: string; t: T; locale: Locale; onLeave(): void }) {
  const it = c.item;
  const kind = kindName(it.kind, t);
  const saved = typeof c.st === 'object' ? c.st : null;
  const ask = confirmDates(it);
  const edit = (): void => {
    rlog(`chat draft edit kind=${it.kind}`);
    setNewItem({ item: it });
    onLeave();
    void goHref(hrefOf(it.kind, 'new'));
  };
  const view = (): void => {
    if (!saved) return;
    rlog(`chat draft open kind=${it.kind}`);
    onLeave();
    openRecord(it.kind, saved.id);
  };
  const editBtn = <button type="button" onClick={edit} disabled={c.st === 'busy'} data-testid="chat-draft-edit">{t('chat.draft.edit', {})}</button>;
  return (
    <div className={`${s.card} ${s.draft}`} data-testid="chat-draft" data-kind={it.kind} data-state={saved ? 'saved' : ask ? 'ask' : c.st}>
      <div className={s.dAsk}>{ask ? t('chat.draft.pastQ', { m: ask.m, d: ask.d }) : t('chat.draft.ask', {})}</div>
      <div className={s.dRow}>
        <RecordMark kind={it.kind} size="md" color={it.kind === 'event' ? calbarColor(it.project ?? undefined) : undefined} />
        <span className={s.main}>
          <span className={s.tt} data-testid="chat-draft-title">{it.title}</span>
          <span className={s.mt} data-testid="chat-draft-meta">{cardMeta(c, today, t, locale)}</span>
          {c.warn ? <span className={s.dWarn} data-testid="chat-draft-warn" data-warn={c.warn.k}>{warnText(c.warn, t)}</span> : null}
        </span>
        <span className={s.kind}>{kind}</span>
      </div>
      {saved ? (
        <button type="button" className={s.dDone} onClick={view} data-testid="chat-draft-open">
          <span aria-hidden="true">✓ </span>
          {t('chat.draft.saved', { kind })}
          <span className={s.dView}>{t('chat.draft.view', {})} ›</span>
        </button>
      ) : ask ? (
        <div className={`${s.btns} ${s.dPick}`}>
          <button type="button" onClick={() => chat.pickCard(turnId, i, 'past')} data-testid="chat-draft-past">
            {t(ask.byMonth ? 'chat.draft.pastMonth' : 'chat.draft.pastYear', { date: ask.past })}
          </button>
          <button type="button" onClick={() => chat.pickCard(turnId, i, 'next')} data-testid="chat-draft-next">
            {t(ask.byMonth ? 'chat.draft.nextMonth' : 'chat.draft.nextYear', { date: ask.next })}
          </button>
          {editBtn}
        </div>
      ) : (
        <div className={s.btns}>
          <button type="button" className={s.dSave} onClick={() => void chat.saveCard(turnId, i)} disabled={c.st === 'busy'} data-testid="chat-draft-save">
            {c.st === 'busy' ? t('chat.draft.busy', {}) : c.st === 'no' ? t('chat.draft.retry', {}) : t('chat.draft.save', {})}
          </button>
          {editBtn}
        </div>
      )}
    </div>
  );
}

export function DraftCards({ turn, today, t, locale, onLeave }: { turn: Extract<Turn, { k: 'ai' }>; today: string; t: T; locale: Locale; onLeave(): void }) {
  if (turn.draftMiss) return <div className={s.dMiss} data-testid="chat-draft-miss">{t('chat.draft.miss', {})}</div>;
  if (turn.cards.length === 0) return null;
  return (
    <div className={s.drafts} data-testid="chat-drafts">
      {turn.cards.map((c, i) => (
        // 卡片按位置，同一条回答里不会重排
        // eslint-disable-next-line react/no-array-index-key
        <Card key={i} c={c} i={i} turnId={turn.id} today={today} t={t} locale={locale} onLeave={onLeave} />
      ))}
    </div>
  );
}
