// “记住的事”的状态：模块里一份，回答下面的“AI 记住了”提示条和“记住的事”页共用，一边删了另一边跟着变。
// • 真身在服务器（private.ai_memories），这里只是本次打开 App 的显示状态，不进本机库
// • remove：服务器删成了才算（gone 记下这条，提示条变“已删掉”、列表拿掉），出一条“已删除 · 撤销”；undo：服务器恢复成了才放回
// • clear：真删全部，不能撤销（方案页：“再点一次：N 件事全部删掉，找不回来”），N 是服务器上的总数
// • 每人最多 5000 条，列表一次一页：load 读第一页，more 接着读，读过的留着
// • 运行日志只记动作、条数、结果，不记内容和 id
import { useSyncExternalStore } from 'react';
import { todayOf, type DateStr } from '../../../../shared/core/date.ts';
import { createSignal } from '../../../../shared/core/signal.ts';
import type { MemoryItem, MemoryListRes, MemoryReq } from '../../../../shared/schema/ai-memory.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { changeMemory, listMemories } from '../data/memory-api.ts';

/** 这条记忆是用户所在时区的哪一天（ui 层不能直接引 core） */
export const memoryDay = (at: number): DateStr => todayOf(at, currentTz());

export type MemToast = { k: 'deleted'; id: string; text: string; full: boolean } | { k: 'failed' };

export interface MemState {
  /** null：还没读到 */
  items: readonly MemoryItem[] | null;
  /** 下一页的游标；null：到底了 */
  next: string | null;
  /** 服务器上一共几条 */
  total: number;
  failed: boolean;
  /** 往后读一页失败了（列表留着，给“重试”） */
  moreFailed: boolean;
  /** 这次打开 App 里删掉的（提示条据此变“已删掉”） */
  gone: ReadonlySet<string>;
  /** 这次打开 App 里撤销了改写的新行（提示条变“已改回：旧”） */
  reverted: ReadonlySet<string>;
  toast: MemToast | null;
}

export interface MemDeps {
  list(signal: AbortSignal, cursor: string | null): Promise<MemoryListRes | null>;
  change(req: Exclude<MemoryReq, { action: 'list' }>, signal: AbortSignal): Promise<boolean>;
}

const EMPTY: MemState = { items: null, next: null, total: 0, failed: false, moreFailed: false, gone: new Set(), reverted: new Set(), toast: null };

export function createMemories(deps: MemDeps = { list: (s, c) => listMemories(s, c), change: (r, s) => changeMemory(r, s) }) {
  let state = EMPTY;
  const sig = createSignal();
  const set = (p: Partial<MemState>): void => {
    state = { ...state, ...p };
    sig.emit();
  };
  /** 读列表的请求：记忆页关掉时取消。写操作不跟着取消（点了删除就要删成） */
  let reader = new AbortController();
  const writeSignal = (): AbortSignal => new AbortController().signal;
  const deleting = new Set<string>();
  /** 删掉的那条原来在第几行：撤销时放回原位，不用重读（已经翻到后面的不被冲掉） */
  const removed = new Map<string, { item: MemoryItem; at: number }>();
  /** 每次重读第一页加一：在路上的旧翻页回来就不要了 */
  let gen = 0;
  let paging = false;

  async function load(): Promise<void> {
    gen += 1;
    const mine = gen;
    reader.abort();
    reader = new AbortController();
    set({ failed: false, moreFailed: false });
    const p = await deps.list(reader.signal, null);
    if (mine !== gen) return;
    rlog(`chat memory list ${p ? `n=${p.items.length} total=${p.total}` : 'fail'}`);
    // 列表在路上时删掉的不放回来
    if (p) set({ items: p.items.filter((m) => !state.gone.has(m.id)), next: p.next, total: p.total, failed: false });
    else set({ failed: true });
  }

  /** 接着读下一页 */
  async function more(): Promise<void> {
    const cursor = state.next;
    if (paging || cursor === null || state.items === null) return;
    paging = true;
    const mine = gen;
    set({ moreFailed: false });
    const p = await deps.list(reader.signal, cursor).finally(() => { paging = false; });
    if (mine !== gen) return;
    rlog(`chat memory more ${p ? `n=${p.items.length}` : 'fail'}`);
    if (!p) return set({ moreFailed: true });
    const have = new Set((state.items ?? []).map((m) => m.id));
    set({ items: [...(state.items ?? []), ...p.items.filter((m) => !have.has(m.id) && !state.gone.has(m.id))], next: p.next, total: p.total });
  }

  /** full：列表里删的，提示写“已删除：前几个字”；提示条里删的只写“已删除” */
  async function remove(id: string, text: string, full: boolean): Promise<void> {
    if (deleting.has(id)) return;   // 连点只发一次
    deleting.add(id);
    const ok = await deps.change({ action: 'delete', id }, writeSignal()).finally(() => deleting.delete(id));
    rlog(`chat memory delete ok=${ok ? 1 : 0}`);
    if (!ok) return set({ toast: { k: 'failed' } });
    const at = state.items?.findIndex((m) => m.id === id) ?? -1;
    const item = state.items?.[at];
    if (item) removed.set(id, { item, at });
    set({ gone: new Set([...state.gone, id]), items: state.items?.filter((m) => m.id !== id) ?? null, total: Math.max(0, state.total - 1), toast: { k: 'deleted', id, text, full } });
  }

  async function undo(id: string): Promise<void> {
    set({ toast: null });
    const ok = await deps.change({ action: 'undo', id }, writeSignal());
    rlog(`chat memory undo ok=${ok ? 1 : 0}`);
    if (!ok) return set({ toast: { k: 'failed' } });
    const gone = new Set(state.gone);
    gone.delete(id);
    set({ gone });
    const back = removed.get(id);
    removed.delete(id);
    if (back && state.items !== null) {
      const items = [...state.items];
      items.splice(Math.min(back.at, items.length), 0, back.item);
      set({ items, total: state.total + 1 });
    } else if (state.items !== null) await load();   // 从提示条删的、列表里没读到这条
  }

  /** 撤销一次改写：服务器把新行换回旧行；列表读过就重读（新旧两行的位置都变了） */
  async function undoReplace(id: string, replaced: string): Promise<void> {
    if (deleting.has(id)) return;
    deleting.add(id);
    const ok = await deps.change({ action: 'undo', id, replaced }, writeSignal()).finally(() => deleting.delete(id));
    rlog(`chat memory undo_replace ok=${ok ? 1 : 0}`);
    if (!ok) return set({ toast: { k: 'failed' } });
    set({ gone: new Set([...state.gone, id]), reverted: new Set([...state.reverted, id]) });
    if (state.items !== null) await load();
  }

  /** 记忆页关掉：取消在路上的读请求，晚到的结果不要 */
  function cancelReads(): void {
    gen += 1;
    reader.abort();
  }

  /** also：这次对话里新记的 id（可能还没翻到），提示条也要变“已删掉” */
  async function clear(also: Iterable<string> = []): Promise<boolean> {
    const ids = [...(state.items?.map((m) => m.id) ?? []), ...also];
    const n = state.total;
    const ok = await deps.change({ action: 'clear' }, writeSignal());
    rlog(`chat memory clear n=${n} ok=${ok ? 1 : 0}`);
    if (!ok) {
      set({ toast: { k: 'failed' } });
      return false;
    }
    gen += 1;   // 在路上的翻页作废
    removed.clear();
    set({ items: [], next: null, total: 0, moreFailed: false, gone: new Set([...state.gone, ...ids]), reverted: new Set(), toast: null });
    return true;
  }

  return {
    load, more, remove, undo, undoReplace, cancelReads, clear,
    closeToast: (): void => set({ toast: null }),
    get: (): MemState => state,
    subscribe: (fn: () => void): (() => void) => sig.subscribe(fn),
    /** 测试用 */
    reset(): void {
      state = EMPTY;
      sig.emit();
    },
  };
}

export type Memories = ReturnType<typeof createMemories>;

/** App 里那一份 */
export const memories: Memories = createMemories();

export function useMemories(m: Memories = memories): MemState {
  return useSyncExternalStore(m.subscribe, m.get, m.get);
}
