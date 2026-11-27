// AI 助手抽屉开没开（照 smart-search 的 find-open.ts）：模块里一份，ChatHost 订阅它画抽屉；n 每打开一次加 1
// • openChat(req)：“＋”打字条点“问 AI”（features/plus 的 hooks/assist-open.ts toChat）经 index.ts 的 loadChatOpen 调；
//   req.ask 是这一句（抽屉挂上就发出去）；长按吉祥物（features/mascot）打开时 ask 为空串，只开抽屉不发
// • record：用完卡上的“改成记下”按记下存这一句（plus 给：只按本机规则、不花 AI 次数，同结果层的“改成记下”）；返回存没存上
// • onAnswered：这一句有了服务器答复（plus 清草稿）
// • setChatRecorder（在 AI 里输入也能记日程、待办）：AI 回答里的确认卡片怎么拆、怎么存，由 plus 交过来
//   （打字条同一套本机规则 planLocal、同一个保存口 saveCapture，经 outbox）；plus 的录音那一块（hooks/voice-main.ts，首屏画完由 TypeBarPreload 加载）加载时经 loadChatOpen 登记一次，同结果层“改成记下”的 setAssistRecorder。
//   这里只经 plus 的 index.ts 引它（功能之间只经 index.ts），也不让对话那一块自己引本机规则（会把解析器拆成和打字条共用的小块，首屏预加载表变长）
// • waitChatRecorder：卡片出不出不能取决于录音那一块加载了没有（长按吉祥物、首屏刚画完就打开时还没登记）。
//   openChat 时还没登记就经 plus 的 index.ts 加载录音那一块（loadTypeBar → loadRecordHost，同 TypeBarPreload 按需加载的同一块，不新拆分包），
//   问第一句前等它登记上（最多 RECORDER_WAIT_MS，加载失败、超时照旧不带 draft，对话本身不受影响）
// 纯 TS，很小
import { createSignal } from '../../../../shared/core/signal.ts';
import type { CaptureItem } from '../../../../shared/logic/capture-map.ts';
import type { ParseResult } from '../../../../shared/logic/parse/parse-split.ts';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { loadTypeBar } from '../../plus/index.ts';

/** 确认卡片用的拆和存（plus 给） */
export interface ChatRecorder {
  /** 一段原话 → 本机规则的结果（learned：照以前怎么分的配的项目名，R-497；只出日程、待办；按用户所在时区、调用这一刻算“明天”“周五”“下午三点”）：items 带 confirm（过去的月日先问），doubts、hints 原样交回 */
  plan(text: string, learned?: string): ParseResult;
  /** R-497：以前分进自建项目的几条（随问题发给 ai-chat，模型照它给每段配项目名）；plan 的 learned 就是配回来的那个，本机规则没认出用户说的项目名时用它 */
  examples(): { title: string; project: string }[];
  /** 卡片上选了“补记今年 / 明年”（同打字条确认行的 applyConfirm）：按选的改日子、去掉 confirm */
  confirm(item: AiItem, choice: 'past' | 'next'): AiItem;
  /** 存一条（经 outbox，离线也先进队列、提醒照旧）；raw 是用户问的那一句原话（存进 raw_text）。存上回表和 id，没存上回 null */
  save(item: CaptureItem, raw: string): Promise<{ table: 'events' | 'todos'; id: string } | null>;
}

/** 等录音那一块登记最多多久 */
export const RECORDER_WAIT_MS = 4_000;

let recorder: ChatRecorder | null = null;
let waiters: ((r: ChatRecorder | null) => void)[] = [];
let loading: Promise<unknown> | null = null;

/** plus 登记（录音那一块加载时登记一次） */
export function setChatRecorder(r: ChatRecorder | null): void {
  recorder = r;
  if (r === null) return;
  const w = waiters;
  waiters = [];
  for (const f of w) f(r);
}

/** 现在登记着的；plus 录音那一块还没加载为 null */
export const chatRecorder = (): ChatRecorder | null => recorder;

/** 加载录音那一块（同时只发一次；失败了下次再试） */
function loadRecorder(): void {
  if (recorder !== null || loading !== null) return;
  loading = loadTypeBar()
    .then((m) => m.loadRecordHost())
    .catch(() => undefined)
    .finally(() => {
      loading = null;
    });
}

/** 登记着就直接给；没登记就加载录音那一块、等它登记，最多 ms 毫秒（等不到回 null） */
export function waitChatRecorder(ms = RECORDER_WAIT_MS): Promise<ChatRecorder | null> {
  if (recorder !== null) return Promise.resolve(recorder);
  loadRecorder();
  return new Promise((res) => {
    const f = (r: ChatRecorder | null): void => {
      clearTimeout(timer);
      waiters = waiters.filter((x) => x !== f);
      res(r);
    };
    const timer = setTimeout(() => f(null), ms);
    waiters.push(f);
  });
}

/** 从哪打开的（只进运行日志） */
export type ChatFrom = 'plus' | 'mascot';

export interface ChatOpenReq {
  ask: string;
  from: ChatFrom;
  record: ((raw: string) => Promise<boolean>) | null;
  onAnswered: (() => void) | null;
}

export interface ChatOpen {
  n: number;
  req: ChatOpenReq;
}

let cur: ChatOpen | null = null;
let seq = 0;
const subs = createSignal();

export function openChat(req: ChatOpenReq): void {
  loadRecorder();
  seq += 1;
  cur = { n: seq, req };
  subs.emit();
}

export function closeChat(): void {
  if (cur === null) return;
  cur = null;
  subs.emit();
}

export const chatOpenSnapshot = (): ChatOpen | null => cur;
export const subscribeChatOpen = (fn: () => void): (() => void) => subs.subscribe(fn);
