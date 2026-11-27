// AI 助手的对话状态（对话历史不落库）：模块里一份，本次打开 App 期间保留，关掉抽屉再打开还在；不进本机库、不同步、服务器不存
// • send(text)：先把这一句画上（我的气泡）、出等待的三个点，再调 ai-chat（历史带最近几轮纯文字，data/chat-api.ts 截）；
//   回来：成功画回答（正文、依据、用量，插在这一句后面），再读一次今天用了几次（platform/ai-usage.ts）；
//   用完 → quotaUntil 记成“到哪个时刻为止”（shared/logic/ai-quota.ts 的 quotaResetAt，和用完卡上的恢复时刻同一个数），
//   过了这个时刻自动恢复（到点有一个定时器，send 时也再比一次当前时间）；
//   没同意 / 没开 AI → 一张去设置打开的卡；别的失败 → “没问到”卡，可以重试（重试把这一句和失败卡拿掉重发）
// • 同一时间只问一句：上一句还没回来时新问的一句先画上、气泡下标“上一句还在问”（Turn.wait），排队，上一句回来再发
// • abort()：关抽屉时调，真的取消正在问的那一句（fetch 跟着断开）；它和排着队的几句都换成“没问到”卡（可以重试），不算服务器答复
// • onAnswered：这一句有了服务器的答复（不是断网、超时、取消）时调一次（“＋”那边清草稿：对话真正发出去才清）；
//   已经用完、根本没发出去的不调（草稿留着）
// • send 可带这一句的图（images，已经压好的 base64）；图只随这一句发一次，不进历史、不留在对话状态里（重试只重发文字）；
//   send 回这一句答上来没有（排队的等到问完），输入条据此决定清不清选的图（失败留着）
// • 记日程待办：拿到 plus 的 ChatRecorder（hooks/chat-open.ts；没登记就先等录音那一块加载）才带 draft；回包的 drafts 在回答到的这一刻用本机规则拆成卡片（cardsOf），
//   存在这条回答的 turn 里（关了抽屉再打开，记过的还是“已记到”）；saveCard 点“记下来”经 plus 的保存口写（outbox），正在存、已记下的不重复存；
//   过去的月日（confirm）先在卡片上选“补记今年 / 明年”（pickCard，同打字条确认行），没选不存；doubts、hints 在卡片上标一句（DraftWarn）；
//   drafts 有、卡片一张都没拆出来时 draftMiss，回答下补一行提示。raw_text 存用户问的那一句（job.q）
// • 运行日志（只记数量、原因、耗时，不记原话、回答、图）：chat send（draft=0/1）/ chat answer / chat fail / chat usage / chat abort /
//   chat draft save / chat draft pick / chat draft miss
import { useSyncExternalStore } from 'react';
import { createSignal } from '../../../../shared/core/signal.ts';
import { todayOf, type DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { quotaResetAt, quotaResetClock } from '../../../../shared/logic/ai-quota.ts';
import type { ChatImageIn, ChatMessage } from '../../../../shared/schema/chat.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { readAiUsage, type AiUsage, type UsageResult } from '../../../platform/ai-usage.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { Doubt, ParseResult } from '../../../../shared/logic/parse/parse-split.ts';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { askChat, type ChatAnswer, type ChatCall, type ChatFail, type ChatResult } from '../data/chat-api.ts';
import { chatRecorder, waitChatRecorder, type ChatRecorder } from './chat-open.ts';

/**
 * 卡片上要标的一句（本机规则 doubts、hints 来的，同打字条提示条的口径）：
 * bad_day 说的日子不存在（“2月30日”，md 是那个月日；年份写全却不存在的 md 为 null），这条没记日子；recur 说了重复，只记最近一次；unsure 本机规则没把握，记之前看一眼
 */
export type DraftWarn = { k: 'bad_day'; md: { month: number; day: number } | null } | { k: 'recur' } | { k: 'unsure' };

/** 一张“要记成这样吗”的卡片：st 是 idle 还没记、busy 正在存、no 没存上（可以再点）、saved 记到了哪张表的哪一条 */
export interface DraftCard {
  /** confirm 不为 null：过去的月日，先选“补记今年 / 明年”（pickCard）才能记 */
  item: AiItem & { kind: 'event' | 'todo' };
  /** 用户问的那一句原话（存进 raw_text；不存模型整理过的那段） */
  raw: string;
  warn: DraftWarn | null;
  st: 'idle' | 'busy' | 'no' | { table: 'events' | 'todos'; id: string };
}

/** 一轮最多出几张卡片（几段原话拆出来的合计） */
export const CARDS_MAX = 10;

/** 算“没把握”的 doubts（multi 一段拆成几件是正常的；confirm、bad_day、recur 各有专门的处理） */
const UNSURE: ReadonlySet<Doubt> = new Set<Doubt>(['leftover', 'rel_conflict', 'empty', 'anniv', 'note', 'too_long']);

const noDay = (it: AiItem): boolean => (it.kind === 'event' ? it.date === null : it.due === null);

function warnOf(r: ParseResult, it: AiItem): DraftWarn | null {
  if (r.doubts.includes('bad_day') && noDay(it)) return { k: 'bad_day', md: r.hints.bad_day };
  if (r.hints.recur) return { k: 'recur' };
  if (r.doubts.some((d) => UNSURE.has(d)) || (it.kind === 'event' && it.date === null)) return { k: 'unsure' };
  return null;
}

/** 回包的几段原话 → 卡片（本机规则拆，只留日程、待办；拆不出来的段不出卡片）。said：用户问的那一句（卡片存进 raw_text） */
export function cardsOf(drafts: readonly string[], rec: ChatRecorder | null, said: string): DraftCard[] {
  if (rec === null) return [];
  const out: DraftCard[] = [];
  for (const text of drafts) {
    const r = rec.plan(text);
    for (const item of r.items) {
      if (item.kind === 'event' || item.kind === 'todo') out.push({ item: { ...item, kind: item.kind }, raw: said, warn: warnOf(r, item), st: 'idle' });
    }
  }
  return out.slice(0, CARDS_MAX);
}

export type Turn =
  /** wait：上一句还在问，这一句排着队 */
  | { k: 'me'; id: number; text: string; wait?: boolean }
  /** draftMiss：模型交回了要记的事，本机规则一张卡片都没拆出来（回答下补一行提示，别让用户以为记下了） */
  | { k: 'ai'; id: number; a: ChatAnswer; usage: AiUsage | null; cards: readonly DraftCard[]; draftMiss: boolean }
  /** voiceAsk：这一句是语音问的，重试时照样带上（答成才退转写那 1 次） */
  | { k: 'fail'; id: number; reason: ChatFail; ask: string; usage?: AiUsage; voiceAsk?: true };

export interface ChatState {
  turns: readonly Turn[];
  busy: boolean;
  /** 今天的次数用完了，到这个时刻（毫秒）为止输入条变灰；没用完为 null */
  quotaUntil: number | null;
}

export interface ChatDeps {
  ask(req: ChatCall, signal: AbortSignal): Promise<ChatResult>;
  usage(): Promise<UsageResult>;
  now(): number;
  tz(): Tz;
  /** 确认卡片的拆和存（plus 登记的，hooks/chat-open.ts）；没登记为 null（点卡片时用） */
  recorder(): ChatRecorder | null;
  /** 问一句之前：没登记就加载录音那一块、等它登记（等不到为 null：请求不带 draft、不出卡片）；直接回值时不多等一拍 */
  waitRecorder(): Promise<ChatRecorder | null> | ChatRecorder | null;
}

const defaults: ChatDeps = {
  ask: askChat, usage: () => readAiUsage(), now: () => clock.now(), tz: () => currentTz(), recorder: chatRecorder, waitRecorder: () => waitChatRecorder(),
};

/** 送出去的历史：我的话 + 成功的回答；失败卡、排着队的不带 */
export function historyOf(turns: readonly Turn[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const t of turns) {
    if (t.k === 'me' && t.wait !== true) out.push({ role: 'user', text: t.text });
    else if (t.k === 'ai') out.push({ role: 'assistant', text: t.a.answer });
  }
  return out;
}

/** 现在是不是用完了（过了恢复时刻就不算） */
export const isQuotaOut = (st: ChatState, now: number): boolean => st.quotaUntil !== null && now < st.quotaUntil;

/** done：这一句有了结果时调一次（true 是答上来了；失败、用完、取消都是 false）。send 的返回值就等它 */
type Queued = { meId: number; q: string; locale: string; onAnswered: (() => void) | undefined; images?: readonly ChatImageIn[] | undefined; voiceAsk: boolean; done: (ok: boolean) => void };

export function createChat(deps: ChatDeps = defaults) {
  let state: ChatState = { turns: [], busy: false, quotaUntil: null };
  let seq = 0;
  let queue: Queued[] = [];
  let inflight: { ac: AbortController; job: Queued } | null = null;
  let quotaTimer: ReturnType<typeof setTimeout> | undefined;
  const sig = createSignal();
  const set = (p: Partial<ChatState>): void => {
    state = { ...state, ...p };
    sig.emit();
  };
  const patch = (id: number, f: (t: Turn) => Turn): void => set({ turns: state.turns.map((t) => (t.id === id ? f(t) : t)) });
  /** 把 turn 插在 afterId 那一条后面（回答紧跟它问的那一句，排着队的几句在后面） */
  const insertAfter = (afterId: number, turn: Turn): Turn[] => {
    const i = state.turns.findIndex((t) => t.id === afterId);
    return i < 0 ? [...state.turns, turn] : [...state.turns.slice(0, i + 1), turn, ...state.turns.slice(i + 1)];
  };
  const nextId = (): number => (seq += 1);

  /** 用完：记到恢复时刻为止，到点自动恢复 */
  function markQuotaOut(): void {
    const now = deps.now();
    const until = quotaResetAt(now);
    set({ quotaUntil: until });
    clearTimeout(quotaTimer);
    quotaTimer = setTimeout(() => {
      if (state.quotaUntil !== null && deps.now() >= state.quotaUntil) set({ quotaUntil: null });
    }, Math.max(0, until - now));
  }
  /** 过了恢复时刻：清掉 */
  function checkQuota(): void {
    if (state.quotaUntil !== null && !isQuotaOut(state, deps.now())) set({ quotaUntil: null });
  }

  /** 回 true：这一句答上来了（排着队的也等到它问完）；没发、失败、用完、取消回 false（带图的那边据此决定清不清图） */
  async function send(text: string, locale: string, onAnswered?: () => void, images?: readonly ChatImageIn[], voiceAsk = false): Promise<boolean> {
    const q = text.trim();
    if (q === '') return false;
    checkQuota();
    const me: Turn = { k: 'me', id: nextId(), text: q };
    // 已经用完了（这次打开 App 里问到过 quota、还没到恢复时刻）：不调服务器，直接画这一句和用完卡（“＋”点“问 AI”交来的，用完卡上能改成记下）。
    // 没发出去，不调 onAnswered（草稿留着）
    if (state.quotaUntil !== null) {
      rlog('chat send skip=quota');
      // 用完卡的“今天 50 / 50”沿用上一张用完卡读到的用量
      const last = state.turns.findLast((t) => t.k === 'fail' && t.usage !== undefined);
      const usage = last?.k === 'fail' ? last.usage : undefined;
      set({ turns: [...state.turns, me, { k: 'fail', id: nextId(), reason: 'quota', ask: q, ...(usage ? { usage } : {}) }] });
      return false;
    }
    let done: (ok: boolean) => void = () => undefined;
    const result = new Promise<boolean>((res) => { done = res; });
    const job: Queued = { meId: me.id, q, locale, onAnswered, images, voiceAsk, done };
    if (state.busy) {
      rlog(`chat send queued=${queue.length + 1}`);
      queue.push(job);
      set({ turns: [...state.turns, { ...me, wait: true }] });
      return result;
    }
    set({ turns: [...state.turns, me], busy: true });
    await run(job);
    return result;
  }

  /** 问一句（我的气泡已经画上、busy 已经设好）；回来以后接着问排着队的下一句 */
  async function run(job: Queued): Promise<void> {
    const upto = state.turns.findIndex((t) => t.id === job.meId);
    const msgs = historyOf(state.turns.slice(0, upto + 1));
    const t0 = deps.now();
    const ac = new AbortController();
    inflight = { ac, job };
    // 卡片出不出不取决于录音那一块加载了没有：没登记就先等它（chat-open.ts 的 waitChatRecorder；等着时关抽屉照样取消）
    let rec = deps.recorder();
    if (rec === null) {
      const w = deps.waitRecorder();
      rec = w instanceof Promise ? await w : w;
      if (ac.signal.aborted) return;
    }
    rlog(`chat send len=${[...job.q].length} hist=${msgs.length - 1} img=${job.images?.length ?? 0} draft=${rec ? 1 : 0}`);
    const r = await deps.ask({ messages: msgs, tz: deps.tz(), locale: job.locale, images: job.images, ...(job.voiceAsk ? { voiceAsk: true } : {}), ...(rec ? { draft: true } : {}) }, ac.signal);
    if (inflight?.ac === ac) inflight = null;
    const ms = deps.now() - t0;
    if (ac.signal.aborted) return;   // abort() 已经换好失败卡、清掉队列
    const id = nextId();
    if (r.ok) {
      const a: ChatAnswer = { answer: r.answer, refs: r.refs, searched: r.searched, found: r.found, webs: r.webs, memories: r.memories, drafts: r.drafts, quotaLeft: r.quotaLeft };
      // 卡片在回答到的这一刻拆（“明天”“周五”按这一刻、用户所在时区算），存进对话状态：关了抽屉再打开，记过的还是“已记到”
      const cards = cardsOf(r.drafts, rec, job.q);
      const draftMiss = r.drafts.length > 0 && cards.length === 0;
      const warns = cards.filter((c) => c.warn !== null || c.item.confirm !== null).length;
      rlog(`chat answer ms=${ms} refs=${r.refs.length} found=${r.found} webs=${r.webs} searched=${r.searched.length} drafts=${r.drafts.length} cards=${cards.length} ask=${warns} left=${r.quotaLeft}`);
      if (draftMiss) rlog(`chat draft miss drafts=${r.drafts.length}`);
      set({ turns: insertAfter(job.meId, { k: 'ai', id, a, usage: null, cards, draftMiss }), busy: false });
      job.onAnswered?.();
      job.done(true);
      void next();
      const u = await deps.usage();
      rlog(`chat usage ${u.ok ? `used=${u.value.used} limit=${u.value.limit}` : `err=${u.err}`}`);
      if (u.ok) patch(id, (t) => (t.k === 'ai' ? { ...t, usage: u.value } : t));
      return;
    }
    rlog(`chat fail reason=${r.reason} code=${r.code} ms=${ms}`);
    // 服务器答复了（没同意、用完、它那边的退路）也算发出去了；断网、超时、没登录不算，草稿留着
    if (r.code !== 'timeout' && r.code !== 'network' && r.code !== 'no_session') job.onAnswered?.();
    set({ turns: insertAfter(job.meId, { k: 'fail', id, reason: r.reason, ask: job.q, ...(job.voiceAsk ? { voiceAsk: true as const } : {}) }), busy: false });
    job.done(false);
    if (r.reason === 'quota') markQuotaOut();
    void next();
    // 用完：读一次今天用了几次，用完卡写“今天 50 / 50”（读不到就不写这半句）
    if (r.reason !== 'quota') return;
    const u = await deps.usage();
    rlog(`chat usage ${u.ok ? `used=${u.value.used} limit=${u.value.limit}` : `err=${u.err}`}`);
    if (u.ok) patch(id, (t) => (t.k === 'fail' ? { ...t, usage: u.value } : t));
  }

  /** 排着队的下一句：去掉“上一句还在问”再发；这时已经用完的，照用完的那一支画 */
  async function next(): Promise<void> {
    const job = queue.shift();
    if (!job) return;
    checkQuota();
    if (state.quotaUntil !== null) {
      const rest = [job, ...queue];
      queue = [];
      let turns = state.turns.map((t) => (t.k === 'me' && t.wait === true ? { k: 'me' as const, id: t.id, text: t.text } : t));
      for (const j of rest) {
        const i = turns.findIndex((t) => t.id === j.meId);
        turns = [...turns.slice(0, i + 1), { k: 'fail', id: nextId(), reason: 'quota', ask: j.q }, ...turns.slice(i + 1)];
      }
      set({ turns });
      for (const j of rest) j.done(false);
      return;
    }
    set({ turns: state.turns.map((t) => (t.id === job.meId && t.k === 'me' ? { k: 'me', id: t.id, text: t.text } : t)), busy: true });
    await run(job);
  }

  /** 关抽屉：取消正在问的那一句；它和排着队的几句换成“没问到”卡 */
  function abort(): void {
    const cur = inflight;
    if (cur === null && queue.length === 0) return;
    const jobs = [...(cur ? [cur.job] : []), ...queue];
    rlog(`chat abort inflight=${cur ? 1 : 0} queued=${queue.length}`);
    queue = [];
    inflight = null;
    cur?.ac.abort();
    let turns = state.turns.map((t) => (t.k === 'me' && t.wait === true ? { k: 'me' as const, id: t.id, text: t.text } : t));
    for (const j of jobs) {
      const i = turns.findIndex((t) => t.id === j.meId);
      const me = turns[i];
      if (me?.k !== 'me') continue;
      turns = [...turns.slice(0, i + 1), { k: 'fail', id: nextId(), reason: 'failed', ask: me.text, ...(j.voiceAsk ? { voiceAsk: true as const } : {}) }, ...turns.slice(i + 1)];
    }
    set({ turns, busy: false });
    for (const j of jobs) j.done(false);
  }

  /** 卡片点“记下来”：经 plus 交来的保存口存这一条（outbox）；正在存、已经记下的再点不重复存。回存上没有 */
  async function saveCard(turnId: number, i: number): Promise<boolean> {
    const rec = deps.recorder();
    const turn = state.turns.find((t) => t.id === turnId);
    const card = turn?.k === 'ai' ? turn.cards[i] : undefined;
    // 过去的月日还没选“补记今年 / 明年”的不存（不悄悄按某一种记）
    if (!rec || !card || card.item.confirm !== null || (card.st !== 'idle' && card.st !== 'no')) return false;
    const setSt = (st: DraftCard['st']): void => patchCard(turnId, i, (c) => ({ ...c, st }));
    setSt('busy');
    let saved: Awaited<ReturnType<ChatRecorder['save']>> = null;
    try {
      saved = await rec.save(card.item, card.raw);
    } catch (e) {
      rlog(`chat draft save threw name=${e instanceof Error ? e.name : typeof e}`);
    }
    rlog(`chat draft save kind=${card.item.kind} ok=${saved ? 1 : 0}`);
    setSt(saved ?? 'no');
    return saved !== null;
  }

  /** 卡片上选了“补记今年 / 明年”：同打字条确认行（plus 交来的 applyConfirm）改日子，选完才能“记下来” */
  function pickCard(turnId: number, i: number, choice: 'past' | 'next'): void {
    const rec = deps.recorder();
    const turn = state.turns.find((t) => t.id === turnId);
    const card = turn?.k === 'ai' ? turn.cards[i] : undefined;
    if (!rec || !card || card.item.confirm === null) return;
    const item = rec.confirm(card.item, choice);
    rlog(`chat draft pick kind=${card.item.kind} choice=${choice}`);
    patchCard(turnId, i, (c) => ({ ...c, item: { ...item, kind: c.item.kind } }));
  }

  function patchCard(turnId: number, i: number, f: (c: DraftCard) => DraftCard): void {
    patch(turnId, (t) => (t.k === 'ai' ? { ...t, cards: t.cards.map((c, j) => (j === i ? f(c) : c)) } : t));
  }

  /** 重试失败的那一句：拿掉它和它前面那句我的话，重新问 */
  function retry(failId: number, locale: string): void {
    const i = state.turns.findIndex((t) => t.id === failId);
    const f = state.turns[i];
    if (!f || f.k !== 'fail') return;
    const prev = state.turns[i - 1];
    const drop = prev?.k === 'me' ? i - 1 : i;
    set({ turns: state.turns.filter((_, j) => j < drop || j > i) });
    void send(f.ask, locale, undefined, undefined, f.voiceAsk === true);
  }

  return {
    send,
    retry,
    abort,
    saveCard,
    pickCard,
    get:(): ChatState => state,
    subscribe: (fn: () => void): (() => void) => sig.subscribe(fn),
    /** 测试用 */
    reset(): void {
      inflight?.ac.abort();
      inflight = null;
      queue = [];
      clearTimeout(quotaTimer);
      state = { turns: [], busy: false, quotaUntil: null };
      sig.emit();
    },
  };
}

export type Chat = ReturnType<typeof createChat>;

/** App 里那一份 */
export const chat: Chat = createChat();

export function useChat(c: Chat = chat): ChatState {
  return useSyncExternalStore(c.subscribe, c.get, c.get);
}

/** 今天（用户所在时区；依据列表算“今天”“逾 N 天”） */
export const todayNow = (): DateStr => todayOf(clock.now(), currentTz());

/** 次数明天几点恢复（用户所在时区的 HH:MM；用完卡、灰掉的输入条） */
export const resetClockNow = (): string => quotaResetClock(clock.now(), currentTz());
