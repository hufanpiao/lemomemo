// AI 助手对话的内容：手机半屏抽屉（ChatDrawer）和网页版右边常驻栏（ChatDock）共用这一份，外壳各自画
// • 对话区：我的气泡；AI 回答（AnswerBlock）；等待中三个点；用完卡（明天几点恢复、去下拉搜索、改成记下）；没同意卡（去打开）；没问到卡（再问一次）
// • 对话区跟到底：新内容出来、对话区变矮都滚到最底，自己往上翻过就不拽回去；上一句还没回来也能接着打字发（hooks/useChat.ts 排队）
// • 建议问题（chips，只有常驻栏给，参考页 .chips）：点了就当这一句发出去
// • 底部输入条：白底大圆角，右边 44 的圆按钮（打了字黄底 ↑，没打字灰）；用完了整条变灰、写“明天 HH:MM 以后再问”；
//   手机上没打字时右边是麦克风（语音提问，hooks/useChatVoice.ts；网页版、电脑版不画，一直是发送钮）；左边“＋”选图（hooks/useChatPics.ts，对话那家不收图就不画）
// • 记住的事（MemoryPage）：开没开由外壳管（抽屉开着时要拉满），这里画
import { Suspense, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { CHAT_TEXT_MAX, type ChatRef } from '../../../../shared/schema/chat.ts';
import { navigate, useRoute } from '../../../app/router.ts';
import { navigateSub } from '../../../app/router-sub.ts';
import { useBlobSrc } from '../../../kit/hooks/useBlobSrc.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { inPlaceTouchEnd, inPlaceTouchStart } from '../../../platform/in-place-focus.ts';
import { MascotPeek } from '../../mascot/index.ts';
import type { ChatOpenReq } from '../hooks/chat-open.ts';
import { chat, isQuotaOut, resetClockNow, todayNow, useChat, type Turn } from '../hooks/useChat.ts';
import { useChatPics } from '../hooks/useChatPics.ts';
import { useChatVoice } from '../hooks/useChatVoice.ts';
import { useFollowBottom } from '../hooks/useFollowBottom.ts';
import { AnswerBlock } from './AnswerBlock.tsx';
import { useChatT, type T } from './chat-parts.tsx';
import s from './ChatDrawer.module.css';
import { MemoryPage, MemToastHost } from './MemoryPage.tsx';
import { RefSheet } from './RefSheet.tsx';

/** 选好的小图：blob: 地址经 kit 的 useBlobSrc 设上 */
function PicImg({ url }: { url: string }) {
  const ref = useBlobSrc(url);
  return <img ref={ref} alt="" />;
}

/** 有下拉搜索的页：在这几页时“去下拉搜索”只关抽屉，别的页先去随手记 */
const PULL_PAGES: ReadonlySet<string> = new Set(['notes', 'todos', 'calendar', 'cal']);

function FailCard({ turn, t, onRetry, onClose, record }: { turn: Extract<Turn, { k: 'fail' }>; t: T; onRetry(): void; onClose(): void; record: ChatOpenReq['record'] }) {
  const route = useRoute();
  const [rec, setRec] = useState<'idle' | 'busy' | 'ok' | 'no'>('idle');
  if (turn.reason === 'quota') {
    const pull = (): void => {
      rlog(`chat quota pull route=${route.name}`);
      onClose();
      if (!PULL_PAGES.has(route.name)) void navigate('notes');
    };
    const asRecord = record === null ? null : (): void => {
      setRec('busy');
      void record(turn.ask).then((ok) => {
        rlog(`chat quota record ok=${ok ? 1 : 0}`);
        setRec(ok ? 'ok' : 'no');
      });
    };
    return (
      <div className={s.card} data-testid="chat-quota">
        <b>{t('chat.quota.h', {})}</b>
        <p>{turn.usage ? t('chat.quota.used', { n: turn.usage.used, limit: turn.usage.limit }) : ''}{t('chat.quota.p', { t: resetClockNow() })}</p>
        <div className={s.btns}>
          <button type="button" onClick={pull} data-testid="chat-quota-pull">{t('chat.quota.pull', {})}</button>
          {asRecord ? (
            <button type="button" onClick={asRecord} disabled={rec === 'busy' || rec === 'ok'} data-testid="chat-quota-record">
              {rec === 'ok' ? t('chat.quota.recorded', {}) : rec === 'no' ? t('chat.quota.notRecorded', {}) : t('chat.quota.record', {})}
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  if (turn.reason === 'consent') {
    return (
      <div className={s.card} data-testid="chat-consent">
        <b>{t('chat.consent.h', {})}</b>
        <p>{t('chat.consent.p', {})}</p>
        <div className={s.btns}>
          <button type="button" onClick={() => { onClose(); void navigateSub('onboarding', 'ai'); }}>{t('chat.consent.go', {})}</button>
        </div>
      </div>
    );
  }
  return (
    <div className={s.card} data-testid="chat-fail">
      <b>{t('chat.fail.h', {})}</b>
      <p>{t('chat.fail.p', {})}</p>
      <div className={s.btns}>
        <button type="button" onClick={onRetry} data-testid="chat-retry">{t('chat.fail.retry', {})}</button>
      </div>
    </div>
  );
}

export interface ChatBodyProps {
  /** 回答画成收起的样子（半屏停在一半时） */
  compact: boolean;
  /** 关掉外壳：抽屉是带退场的 close（卡片上的“去下拉搜索”“去打开”）；常驻栏不关，给空函数 */
  close(): void;
  /** 点开一条引用、离开这一页时关外壳（抽屉直接卸下）；常驻栏给空函数 */
  onLeave(): void;
  /** 用完卡上的“改成记下”（“＋”打开时 plus 给的）；没有时不画那颗按钮 */
  record: ChatOpenReq['record'];
  memOpen: boolean;
  setMemOpen(v: boolean): void;
  /** 建议问题（常驻栏给，点了直接问）；不给不画 */
  chips?: readonly string[] | undefined;
  /** 输入框的 ref（常驻栏收到“＋”交来的空问题时把光标放进来） */
  fieldRef?: RefObject<HTMLInputElement | null> | undefined;
}

export function ChatBody({ compact, close, onLeave, record, memOpen, setMemOpen, chips, fieldRef }: ChatBodyProps) {
  const t = useChatT();
  const locale = useUi((x) => x.locale);
  const st = useChat();
  const [text, setText] = useState('');
  const [pick, setPick] = useState<ChatRef | null>(null);
  const today = todayNow();

  // 对话区跟到底（hooks/useFollowBottom.ts）
  const lastMe = [...st.turns].reverse().find((x) => x.k === 'me')?.id ?? 0;
  const { ref: feed, onScroll: onFeedScroll } = useFollowBottom(lastMe);

  const pics = useChatPics();
  const fileRef = useRef<HTMLInputElement>(null);
  const [picFail, setPicFail] = useState(false);
  const sendText = (q: string, voiceAsk = false): void => {
    // 图答上来了才清，没成留着
    const { images, settle } = pics.attach();
    void chat.send(q, locale, undefined, images, voiceAsk).then(settle);
    setText('');
    setPicFail(false);
  };
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (text.trim() === '' || pics.busy) return;
    sendText(text);
  };
  // 语音提问：转出来的字当这一句发；图还在压缩时先放进输入框，等压好自己点发送
  const voice = useChatVoice(locale, (q) => {
    if (pics.busy) setText(q);
    else sendText(q, true);
  });
  const fresh = new Set(st.turns.flatMap((x) => (x.k === 'ai' ? x.a.memories.map((m) => m.id) : [])));
  const off = isQuotaOut(st, clock.now());
  // 上一句还在问也能发（排队）；用完了、没打字不能发
  const canSend = !off && text.trim() !== '';
  // 没打字时右边是麦克风（参考 .composer .mic）；用完了照旧是灰的发送钮
  const showMic = voice.supported && !off && text.trim() === '';
  const listening = voice.phase !== 'idle';
  const { cancel: cancelVoice } = voice;
  // 按住时次数用完：麦克风按钮会消失、收不到松手，这一段不要了
  useEffect(() => {
    if (off) cancelVoice();
  }, [off, cancelVoice]);
  const placeholder = off ? t('chat.off', { t: resetClockNow() }) : voice.phase === 'rec' ? t('chat.v.rec', {}) : voice.phase === 'send' ? t('chat.v.send', {}) : t(voice.supported ? 'chat.ph' : 'chat.phText', {});

  return (
    <>
      <div ref={feed} className={s.feed} onScroll={onFeedScroll} data-testid="chat-feed">
        {st.turns.map((x) =>
          x.k === 'me' ? (
            <div key={x.id} data-turn={x.id}>
              <div className={s.me} data-testid="chat-me">{x.text}</div>
              {x.wait === true ? <div className={s.wait} data-testid="chat-wait">{t('chat.wait', {})}</div> : null}
            </div>
          ) : x.k === 'ai' ? (
            <AnswerBlock key={x.id} turn={x} compact={compact} today={today} t={t} locale={locale} onPick={setPick} onMem={() => setMemOpen(true)} onLeave={onLeave} />
          ) : (
            <FailCard key={x.id} turn={x} t={t} onRetry={() => chat.retry(x.id, locale)} onClose={close} record={record} />
          ),
        )}
        {st.busy ? (
          <div className={s.think} role="status" aria-label={t('chat.think', {})} data-testid="chat-think">
            <i />
            <i />
            <i />
          </div>
        ) : null}
      </div>
      {chips?.length ? (
        <div className={s.chips} data-testid="chat-chips">
          {chips.map((c) => (
            <button key={c} type="button" className={s.chip} disabled={off} onClick={() => sendText(c)}>
              {c}
            </button>
          ))}
        </div>
      ) : null}
      {pics.pics.length > 0 || picFail ? (
        <div className={s.pics} data-testid="chat-pics">
          {pics.pics.map((p) => (
            <button key={p.id} type="button" className={s.pic} onClick={() => pics.remove(p.id)} disabled={pics.sending} aria-label={t('chat.picRemove', {})} data-testid="chat-pic">
              <PicImg url={p.url} />
            </button>
          ))}
          {picFail ? <span className={s.picFail} role="status" data-testid="chat-pic-fail">{t('chat.picFail', {})}</span> : null}
        </div>
      ) : null}
      {voice.hint !== null && !listening ? <div className={s.vHint} role="status" data-testid="chat-voice-hint">{t(`chat.v.${voice.hint}`, {})}</div> : null}
      <form className={[s.composer, pics.allowed ? s.withAdd : '', off ? s.off : ''].filter(Boolean).join(' ')} onSubmit={onSubmit} data-testid="chat-composer">
        <Suspense fallback={null}>
          <MascotPeek kind="chat" />
        </Suspense>
        {pics.allowed ? (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              tabIndex={-1}
              onChange={(e) => {
                const fs = [...(e.target.files ?? [])];
                e.target.value = '';
                void pics.add(fs).then((ok) => setPicFail(!ok));
              }}
              data-testid="chat-pic-input"
            />
            <button
              type="button"
              className={s.add}
              onClick={() => fileRef.current?.click()}
              disabled={off || !pics.room || pics.busy}
              aria-label={t('chat.pic', {})}
              data-testid="chat-pic-add"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14" /></svg>
            </button>
          </>
        ) : null}
        <input
          ref={fieldRef}
          className={s.field}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onTouchStart={inPlaceTouchStart}
          onTouchEnd={inPlaceTouchEnd}
          placeholder={placeholder}
          aria-label={t(voice.supported ? 'chat.ph' : 'chat.phText', {})}
          disabled={off || listening}
          enterKeyHint="send"
          maxLength={CHAT_TEXT_MAX}
          data-testid="chat-input"
        />
        {showMic ? (
          <button
            type="button"
            className={voice.phase === 'rec' ? `${s.mic} ${s.micOn}` : s.mic}
            disabled={voice.phase === 'send'}
            aria-label={t('chat.mic', {})}
            aria-pressed={voice.phase === 'rec'}
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); voice.down(); }}
            onPointerUp={voice.up}
            onPointerCancel={voice.cancel}
            onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); voice.down(); } }}
            onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); voice.up(); } }}
            onBlur={() => { if (voice.phase === 'rec') voice.cancel(); }}
            onContextMenu={(e) => e.preventDefault()}
            data-testid="chat-mic"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
          </button>
        ) : (
          <button type="submit" className={s.send} disabled={!canSend} aria-label={t('chat.send', {})} data-testid="chat-send">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
          </button>
        )}
      </form>
      <RefSheet r={pick} today={today} t={t} locale={locale} onClose={() => setPick(null)} onOpen={() => { setPick(null); onLeave(); }} />
      {memOpen ? <MemoryPage t={t} fresh={fresh} onBack={() => setMemOpen(false)} /> : null}
      <MemToastHost t={t} hidden={memOpen} />
    </>
  );
}
