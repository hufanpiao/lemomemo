// “记住的事”（照方案页 memScreen 和截图_记住的事）：对话抽屉右上“记住的事”、提示条“查看”进来，Portal 到 body 盖满整屏，用页面渐变底 --scr-bg（方案 .scr）；Esc、返回都回到抽屉。
// • 顶上“‹ 返回”、中间“AI 记住的事”；一段说明；白卡列表（每行文字、“11月22日 · 来自对话”、右边红字“删除”，这次打开 App 新记的带“新”）；最底下“全部清空”
// • 删除带撤销（UndoToast，“已删除：前 10 个字…”）；全部清空在原地要再点一次（“再点一次：N 件事全部删掉，找不回来”），真删、不能撤销
// MemoPill：回答下面的浅底提示“AI 记住了：……”，右边“查看”“删掉”；删掉后写“已删掉，AI 不会再用这条”、变淡（方案页 memoDel）
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatMemory } from '../../../../shared/schema/ai-memory.ts';
import { SheetTop } from '../../../kit/components/SheetTop.tsx';
import { UndoToast } from '../../../kit/components/UndoToast.tsx';
import { useLayer } from '../../../kit/hooks/useLayer.ts';
import { memories, memoryDay, useMemories } from '../hooks/useMemories.ts';
import type { T } from './chat-parts.tsx';
import s from './MemoryPage.module.css';

/** 撤销条里最多写几个字（方案页） */
const TOAST_CHARS = 10;
/** “全部清空”第一次点完，等第二次点多久 */
const CLEAR_SURE_MS = 4_000;

const shortOf = (text: string): string => {
  const c = [...text];
  return c.length > TOAST_CHARS ? `${c.slice(0, TOAST_CHARS).join('')}…` : text;
};

export function MemoPill({ m, t, onView }: { m: ChatMemory; t: T; onView(): void }) {
  const st = useMemories();
  const gone = st.gone.has(m.id);
  const old = m.replaced;
  const said = old ? t('chat.mem.rewrote', { a: old.text, b: m.text }) : t('chat.mem.said', { t: m.text });
  const goneText = old && st.reverted.has(m.id) ? t('chat.mem.reverted', { t: old.text }) : t('chat.mem.gone', {});
  return (
    <div className={gone ? `${s.memo} ${s.memoGone}` : s.memo} data-testid="chat-memo">
      <span className={s.dot} aria-hidden="true" />
      <span className={s.tx}>{gone ? goneText : said}</span>
      {gone ? null : (
        <>
          <button type="button" onClick={onView} data-testid="chat-memo-view">{t('chat.mem.view', {})}</button>
          {old ? (
            <button type="button" onClick={() => void memories.undoReplace(m.id, old.id)} data-testid="chat-memo-undo">{t('chat.mem.undo', {})}</button>
          ) : (
            <button type="button" onClick={() => void memories.remove(m.id, m.text, false)} data-testid="chat-memo-del">{t('chat.mem.del', {})}</button>
          )}
        </>
      )}
    </div>
  );
}

/** 删除后的撤销条（提示条、列表共用一条）：记忆页是模态层，开着时条要画在页里才点得到 */
function MemToastBar({ t }: { t: T }) {
  const { toast } = useMemories();
  if (toast === null) return null;
  if (toast.k === 'failed') {
    return <UndoToast key="failed" message={t('chat.mem.failed', {})} onClose={memories.closeToast} role="alert" data-testid="chat-mem-toast" />;
  }
  return (
    <UndoToast
      key={toast.id}
      message={toast.full ? t('chat.mem.deletedT', { t: shortOf(toast.text) }) : t('chat.mem.deleted', {})}
      undoLabel={t('chat.mem.undo', {})}
      onUndo={() => void memories.undo(toast.id)}
      onClose={memories.closeToast}
      solo="keep"
      data-testid="chat-mem-toast"
    />
  );
}

/** 抽屉里那一份；hidden：记忆页开着，条由页自己画 */
export function MemToastHost({ t, hidden }: { t: T; hidden: boolean }) {
  useEffect(() => memories.closeToast, []);   // 关抽屉时收掉，下次打开不再冒出旧的撤销条
  return hidden ? null : <MemToastBar t={t} />;
}

function dateOf(at: number, t: T): string {
  const [, mo = '1', da = '1'] = memoryDay(at).split('-');
  return t('chat.mem.when', { m: Number(mo), d: Number(da) });
}

export function MemoryPage({ t, fresh, onBack }: { t: T; fresh: ReadonlySet<string>; onBack(): void }) {
  const st = useMemories();
  const [sure, setSure] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const tail = useRef<HTMLDivElement>(null);
  useLayer(true, { name: 'chat-memory', modal: true, el: () => root.current, onEsc: onBack });
  useEffect(() => {
    void memories.load();
    back.current?.focus({ preventScroll: true });
    return memories.cancelReads;
  }, []);
  // “全部清空”点过一次后，几秒内没再点就复位
  useEffect(() => {
    if (!sure) return;
    const timer = setTimeout(() => setSure(false), CLEAR_SURE_MS);
    return () => clearTimeout(timer);
  }, [sure]);
  // 滚到离底 400px 就接着读下一页；next 变了换新的观察，读完一页还在视野里会接着读
  useEffect(() => {
    const el = tail.current;
    if (!el || st.next === null || st.moreFailed) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) void memories.more();
    }, { root: scroller.current, rootMargin: '0px 0px 400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [st.next, st.moreFailed]);
  const items = st.items ?? [];
  const onClear = (): void => {
    if (!sure) return setSure(true);
    setSure(false);
    void memories.clear(fresh);
  };
  return createPortal(
    <div ref={root} className={s.page} role="dialog" aria-modal="true" aria-label={t('chat.mem.title', {})} data-testid="chat-mem-page">
      <SheetTop title={t('chat.mem.title', {})} left={{ kind: 'back', label: t('chat.mem.back', {}), onClick: onBack, testId: 'chat-mem-back', btnRef: back }} />
      <div ref={scroller} className={s.body}>
        <p className={s.note}>{t('chat.mem.note', {})}</p>
        {st.items === null ? (
          st.failed ? (
            <div className={s.tile}>
              <div className={s.empty}>
                {t('chat.mem.loadFail', {})}
                <button type="button" className={s.retry} onClick={() => void memories.load()} data-testid="chat-mem-retry">{t('chat.fail.retry', {})}</button>
              </div>
            </div>
          ) : null
        ) : (
          <>
          {st.failed ? (
            <button type="button" className={s.retry} onClick={() => void memories.load()} data-testid="chat-mem-reload">{t('chat.mem.reloadFail', {})}</button>
          ) : null}
          <div className={s.tile} data-testid="chat-mem-list">
            {items.length === 0 ? <div className={s.empty}>{t('chat.mem.empty', {})}</div> : items.map((m) => (
              <div key={m.id} className={s.row} data-testid="chat-mem-row">
                <div className={s.main}>
                  <div className={s.tt}>{fresh.has(m.id) ? <span className={s.new}>{t('chat.mem.new', {})}</span> : null}{m.text}</div>
                  <div className={s.mt}>{dateOf(m.at, t)}</div>
                </div>
                <button type="button" className={s.del} onClick={() => void memories.remove(m.id, m.text, true)} aria-label={t('chat.mem.delA', { t: m.text })} data-testid="chat-mem-del">{t('chat.mem.delete', {})}</button>
              </div>
            ))}
          </div>
          </>
        )}
        {st.next !== null ? <div ref={tail} aria-hidden="true" data-testid="chat-mem-tail" /> : null}
        {st.moreFailed ? <button type="button" className={s.retry} onClick={() => void memories.more()} data-testid="chat-mem-more-retry">{t('chat.fail.retry', {})}</button> : null}
        {items.length > 0 ? (
          <button type="button" className={s.clear} onClick={onClear} data-testid="chat-mem-clear">
            {sure ? t('chat.mem.clearSure', { n: st.total }) : t('chat.mem.clear', {})}
          </button>
        ) : null}
      </div>
      <MemToastBar t={t} />
    </div>,
    document.body,
  );
}
