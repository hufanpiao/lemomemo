// 提醒横幅的队列（架构 5.9“提醒的排队规则”；B2 任务单 FA-4；TC-B2-22）：跨功能的界面状态，放 kit（今天页、“＋”录音面板都要读或写，
// 功能之间不能互相 import，A27）。只放界面状态：哪几条在响（kind、id、dueAt）、谁在压着、收起了哪几条；不放条目内容（内容由提醒功能从本机集合读）
// • 正在录音（“＋”录音面板，B3 接）或键盘弹起（提醒功能自己盯 platform/viewport）时 holdReminders(reason) 压住，横幅先排队；
//   全部放开后按顺序一条一条出（visible 只取队首）
// • 隐私记解锁中照常显示（隐私记不压）
// • 横幅不自动收起，处理了才消失（提醒功能处理完调 remove）；往上滑先收起（collapse），收起的进“错过的提醒”
// • 按了“稍后”弹 2 秒“15:25 再提醒你”（snoozeNote，提醒功能负责到时清掉）
// • armedSince：提醒引擎（RemindHost）armed 了没有、从哪一刻起到点的算“本次打开以后”。引擎 armed 时写，卸载时清成 null。
//   今天页等它不是 null 才挂“错过的提醒”，分包也那时才下载、不进首屏（REMIND-shown-persist 修订 1 P2，主持人 11-05 定，改掉原来 J1 的
//   “按打开时刻一打开就挂”；REMIND-missed-flash：引擎没挂上时队列是空的，打开后刚到点的那条会先算进“错过 1 条”再跳进横幅）
// • remindDown：引擎这次打开挂不上了（RemindHost 出错、分包下载失败，App 的错误边界吞掉、不再重试；或者挂上以后约 15 秒还没 armed，
//   App 的看门狗写，之后 armed 了再清掉）。App 写，换账号时清掉。
//   今天页看到它也挂“错过的提醒”，不传 since、照旧全算（今天页待办 代码审查 M1：引擎坏了提醒不响，“错过的提醒”是页面上唯一的信号）
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { logEvent } from '../../../shared/core/log-bus.ts';

export type RemindHoldReason = 'recording' | 'keyboard';

export interface RemindEntry {
  readonly kind: 'event' | 'todo' | 'anniv';
  readonly id: string;
  /** 这一次到点的时刻（epoch ms） */
  readonly dueAt: number;
  /** "<kind>:<id>:<dueAt>"（和通知 tag 同一规则） */
  readonly tag: string;
}

export interface RemindQueueState {
  /** 正在响、还没处理的（先到先出） */
  readonly entries: readonly RemindEntry[];
  /** 压着横幅的原因（每次 hold 一个令牌，同一原因可以压多次） */
  readonly holds: readonly { readonly token: number; readonly reason: RemindHoldReason }[];
  /** 往上滑收起的 tag：不再当横幅出，进“错过的提醒” */
  readonly collapsed: ReadonlySet<string>;
  /** “15:25 再提醒你”：要显示的时刻（epoch ms）；null 不显示 */
  readonly snoozeNote: number | null;
  /** 提醒引擎挂上时的 since（epoch ms，见上面头注释）；没挂上是 null */
  readonly armedSince: number | null;
  /** 引擎这次打开挂不上了（见文件头） */
  readonly remindDown: boolean;
}

const EMPTY: ReadonlySet<string> = new Set();

export const remindQueue = createStore<RemindQueueState>()(() => ({ entries: [], holds: [], collapsed: EMPTY, snoozeNote: null, armedSince: null, remindDown: false }));

let seq = 0;

/** 一次压住最长多久：到了自动放开并记日志（代码审查中 4：调用方忘了放开时横幅不会永久卡住） */
export const HOLD_MAX_MS = 10 * 60_000;

/** 压住提醒横幅（录音中、键盘弹起）；返回放开函数（多次调用只放一次）。超过 maxMs 自动放开并记日志。
 *  React 组件里优先用 kit/hooks/useHoldReminders.ts（卸载时自动放开） */
export function holdReminders(reason: RemindHoldReason, maxMs: number = HOLD_MAX_MS): () => void {
  const token = ++seq;
  remindQueue.setState((s) => ({ holds: [...s.holds, { token, reason }] }));
  let done = false;
  const release = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    remindQueue.setState((s) => ({ holds: s.holds.filter((h) => h.token !== token) }));
  };
  const timer = setTimeout(() => {
    if (done) return;
    release();
    logEvent('remind_hold_timeout', { code: reason });
  }, maxMs);
  return release;
}

/** 换成这一批在响的（提醒功能每分钟算一次）：顺序按先来的保留，新来的排后面；已收起的不进 */
export function setRinging(next: readonly RemindEntry[]): void {
  remindQueue.setState((s) => {
    const want = new Map(next.filter((e) => !s.collapsed.has(e.tag)).map((e) => [e.tag, e]));
    const kept = s.entries.filter((e) => want.has(e.tag));
    const keptTags = new Set(kept.map((e) => e.tag));
    const added = [...want.values()].filter((e) => !keptTags.has(e.tag));
    const entries = [...kept, ...added];
    const same = entries.length === s.entries.length && entries.every((e, i) => e === s.entries[i] || e.tag === s.entries[i]?.tag);
    return same ? s : { entries };
  });
}

/** 处理掉了（知道了、稍后）：从队列里拿掉 */
export function removeRinging(tag: string): void {
  remindQueue.setState((s) => (s.entries.some((e) => e.tag === tag) ? { entries: s.entries.filter((e) => e.tag !== tag) } : s));
}

/** 往上滑收起：拿出队列、记进收起（进“错过的提醒”） */
export function collapseRinging(tag: string): void {
  remindQueue.setState((s) => ({ entries: s.entries.filter((e) => e.tag !== tag), collapsed: new Set([...s.collapsed, tag]) }));
}

export function setSnoozeNote(at: number | null): void {
  remindQueue.setState({ snoozeNote: at });
}

/** 提醒引擎挂上（传 since）、卸载（传 null）时调；只有提醒功能的引擎写 */
export function setRemindArmed(since: number | null): void {
  remindQueue.setState((s) => (s.armedSince === since ? s : { armedSince: since }));
}

/** 引擎出错（App 的错误边界 onError、看门狗）时写 true，armed 了（看门狗写的那种）或那一份提醒卸载（换账号、退出）时写 false；只有 App 写 */
export function setRemindDown(down: boolean): void {
  remindQueue.setState((s) => (s.remindDown === down ? s : { remindDown: down }));
}

/** 退出、换账号时清空（提醒功能在账号变了时调） */
export function resetRemindQueue(): void {
  remindQueue.setState({ entries: [], collapsed: EMPTY, snoozeNote: null });
}

/** 收起记录只留最近 7 天（和“错过的提醒”同一窗口；代码审查低 8）：dueAt 早于 before 的丢掉 */
export function pruneCollapsed(before: number): void {
  remindQueue.setState((s) => {
    const keep = [...s.collapsed].filter((tag) => Number(tag.slice(tag.lastIndexOf(':') + 1)) >= before);
    return keep.length === s.collapsed.size ? s : { collapsed: new Set(keep) };
  });
}

/** 现在该露出来的那一条：没被压着时取队首 */
export function visibleEntry(s: RemindQueueState): RemindEntry | null {
  return s.holds.length === 0 ? (s.entries[0] ?? null) : null;
}

/** React 里按需取一部分：useRemindQueue(visibleEntry) */
export function useRemindQueue<T>(selector: (s: RemindQueueState) => T): T {
  return useStore(remindQueue, selector);
}
