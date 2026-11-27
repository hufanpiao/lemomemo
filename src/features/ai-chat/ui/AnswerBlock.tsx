// 一条 AI 回答（照方案页 .ai、.lbl、.sup、.basis、.ref、.usage；联网照方案页“联网”截图 webFeed）：
// • 上面一行灰字（chat-parts.tsx 的 lblOf）：没联网“查了你的日程、待办、随手记 · 找到 5 条”；联网了“联网查了 2 个网页 · 用了你的 1 条日程”
// • 正文纯文本（不渲染模型给的 HTML、链接），按空行分段；[n] 画成小号上标（kit withCites，和结果层同一份）
// • 依据列表：记录和网页来源按正文里第一次出现的顺序一起编号（服务器排好）：
//   记录行“序号 + 记号 + 标题、第二行 + 类型小签 + ›”，点了打开贴底弹层（RefSheet）；行首记号用 kit RecordMark（size md）；
//     日程竖条的项目色按日程 id 从本机库查（chat-parts.tsx 的 useEventProjects）；
//   网页行“序号 + 字母方块（.fav）+ 标题、网站名 + ‘网页’小签 + ↗”，点了用浏览器打开服务器给的原样网址（window.open，noopener、noreferrer；
//     谷歌条款：不改链接、不加中间页、不记点了哪个——运行日志只记“点了第几个网页”，不记网址）；
//   半屏时只列前 3 条，下面写“还有 N 条 · 往上拉看全部”（参考的半屏态）；拉满了全列，下面写“这次用了 1 次 AI · 今天 N / 50”
// • 记日程待办：正文下面接“要记成这样吗”卡片（DraftCards.tsx，没有要记的不画）
import { withCites } from '../../../kit/components/Cites.tsx';
import { RecordMark } from '../../../kit/components/RecordMark.tsx';
import { rlog } from '../../../platform/run-log-api.ts';
import type { Turn } from '../hooks/useChat.ts';
import { calbarColor, favLetter, kindName, lblOf, refMeta, useEventProjects, type Locale, type T } from './chat-parts.tsx';
import type { ChatRef, ChatWebRef } from '../../../../shared/schema/chat.ts';
import s from './ChatDrawer.module.css';
import { DraftCards } from './DraftCards.tsx';
import { MemoPill } from './MemoryPage.tsx';

/** 半屏时依据列表只列几条 */
export const COMPACT_REFS = 3;

function WebRow({ r, i, t }: { r: ChatWebRef; i: number; t: T }) {
  const open = (): void => {
    rlog(`chat web open i=${i + 1}`);
    window.open(r.url, '_blank', 'noopener,noreferrer');
  };
  return (
    <button type="button" className={s.ref} onClick={open} data-testid="chat-ref" data-kind="web" aria-label={t('chat.webOpen', { t: r.title })}>
      <span className={s.num}>{i + 1}</span>
      <span className={s.fav} aria-hidden="true">{favLetter(r.site, r.title)}</span>
      <span className={s.main}>
        <span className={s.tt}>{r.title}</span>
        {r.site === '' ? null : <span className={s.mt}>{r.site}</span>}
      </span>
      <span className={s.kind}>{kindName('web', t)}</span>
      <span className={s.chev} aria-hidden="true">↗</span>
    </button>
  );
}

export function AnswerBlock({ turn, compact, today, t, locale, onPick, onMem, onLeave }: {
  turn: Extract<Turn, { k: 'ai' }>; compact: boolean; today: string; t: T; locale: Locale; onPick(r: ChatRef): void; onMem(): void;
  /** 卡片“改一下”“查看”要离开抽屉去别的页 */
  onLeave(): void;
}) {
  const a = turn.a;
  const refs = compact ? a.refs.slice(0, COMPACT_REFS) : a.refs;
  const more = a.refs.length - refs.length;
  const lbl = lblOf(a, t);
  const paras = a.answer.split(/\n+/).filter((p) => p.trim() !== '');
  const usage = turn.usage;
  const projectOf = useEventProjects();
  return (
    <div className={s.ai} data-testid="chat-answer">
      {lbl === '' ? null : <div className={s.lbl} data-testid="chat-lbl">{lbl}</div>}
      {paras.map((p, i) => (
        // 段落按位置，不会重排
        // eslint-disable-next-line react/no-array-index-key
        <p key={i}>{withCites(p, a.refs.length, s.sup, 'chat-cite')}</p>
      ))}
      <DraftCards turn={turn} today={today} t={t} locale={locale} onLeave={onLeave} />
      {refs.length > 0 ? (
        <ul className={s.basis} data-testid="chat-basis">
          {refs.map((r, i) => {
            if (r.kind === 'web') {
              return (
                <li key={`web:${r.url}`}>
                  <WebRow r={r} i={i} t={t} />
                </li>
              );
            }
            const m = refMeta(r, today, t, locale);
            return (
              <li key={`${r.kind}:${r.id}`}>
                <button type="button" className={s.ref} onClick={() => onPick(r)} data-testid="chat-ref" data-kind={r.kind}>
                  <span className={s.num}>{i + 1}</span>
                  <RecordMark kind={r.kind} done={r.done === true} size="md" color={r.kind === 'event' ? calbarColor(projectOf(r.id)) : undefined} />
                  <span className={s.main}>
                    <span className={s.tt}>{r.title}</span>
                    {m.text === '' ? null : <span className={m.late ? `${s.mt} ${s.late}` : s.mt}>{m.text}</span>}
                  </span>
                  <span className={s.kind}>{kindName(r.kind, t)}</span>
                  <span className={s.chev} aria-hidden="true">›</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {a.memories.map((m) => <MemoPill key={m.id} m={m} t={t} onView={onMem} />)}
      {more > 0 ? (
        <div className={s.usage} data-testid="chat-more">{t('chat.more', { n: more })}</div>
      ) : (
        <div className={s.usage} data-testid="chat-usage">
          {t('chat.usage', {})}
          {usage ? ` · ${usage.unlimited ? t('chat.todayFree', { used: usage.used }) : t('chat.today', { used: usage.used, limit: usage.limit })}` : ''}
        </div>
      )}
    </div>
  );
}
