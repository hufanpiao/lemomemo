// 同步引擎对外的样子（engine.ts 用）：Sync 接口、状态和事件的订阅（createHub）、本机库不可用时的空引擎（inertSync）
// 纯 TS：不准 import React 和任何功能（A1）
import type { SyncEvent, SyncState } from './types.ts';

export interface Sync {
  start(): void;
  stop(): void;
  /**
   * 放手（4.3b：主页隐藏、换主页）：不再排新活、断 Realtime、停定时器，等正在跑的那件活结束（最多 ms，默认 20 秒，即单请求超时），
   * 然后停下。正在发送的项照常写回（超时后回包才到也照常写回）；万一还残留 inflight（崩溃、请求一直不回），
   * 下一个主页 start() 时改回 pending，按原 op_id 重发（幂等；项带 sent，不再合并新修改）
   */
  drain(ms?: number): Promise<void>;
  /** 先发后拉，跑完 resolve（不抛） */
  syncNow(): Promise<void>;
  /** 只发（不抛） */
  sendNow(): Promise<void>;
  /** 等串行链上已排的活跑完（测试用） */
  idle(): Promise<void>;
  getState(): SyncState;
  subscribe(listener: () => void): () => void;
  onEvent(fn: (e: SyncEvent) => void): () => void;
}

const STOPPED: SyncState = { syncing: false, realtime: 'down', lastPullAt: null, stopped: true };

/** cache、outbox 不可用时的空引擎：什么也不做、不抛 */
export function inertSync(): Sync {
  return {
    start: () => undefined,
    stop: () => undefined,
    drain: () => Promise.resolve(),
    syncNow: () => Promise.resolve(),
    sendNow: () => Promise.resolve(),
    idle: () => Promise.resolve(),
    getState: () => STOPPED,
    subscribe: () => () => undefined,
    onEvent: () => () => undefined,
  };
}

export interface Hub extends Pick<Sync, 'getState' | 'subscribe' | 'onEvent'> {
  setState(patch: Partial<SyncState>): void;
  emit(e: SyncEvent): void;
  /** 跑一件活，期间 syncing = true */
  busy(task: () => Promise<void>): Promise<void>;
}

/** 同步状态和事件的订阅（界面的“正在同步…”、冲突提示）；状态不变时引用不变 */
export function createHub(): Hub {
  let state: SyncState = { syncing: false, realtime: 'down', lastPullAt: null, stopped: false };
  const listeners = new Set<() => void>();
  const eventListeners = new Set<(e: SyncEvent) => void>();
  const add = <T>(set: Set<T>, x: T): (() => void) => {
    set.add(x);
    return () => {
      set.delete(x);
    };
  };
  const setState = (patch: Partial<SyncState>): void => {
    if ((Object.keys(patch) as (keyof SyncState)[]).every((k) => patch[k] === state[k])) return;
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  };
  return {
    getState: () => state,
    subscribe: (l) => add(listeners, l),
    onEvent: (fn) => add(eventListeners, fn),
    setState,
    emit(e) {
      for (const l of [...eventListeners]) l(e);
    },
    async busy(task) {
      setState({ syncing: true });
      try {
        await task();
      } finally {
        setState({ syncing: false });
      }
    },
  };
}
