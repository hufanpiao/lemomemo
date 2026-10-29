// 日志上传队列测试的共用假件：假 localStorage 的一个键、带假上传 / 假定时器 / 假网络的队列
import { vi } from 'vitest';
import { createLogQueue, type LogQueueDeps, type LogRow, type LogUploadResult } from '../queue.ts';

/** 假 localStorage 的一个键；broken = 读写都失败（隐私模式、被禁用） */
export function memStore() {
  const s = { text: null as string | null, broken: false };
  const store: LogQueueDeps['store'] = {
    read: () => (s.broken ? undefined : s.text),
    write: (t) => {
      if (s.broken) return false;
      s.text = t;
      return true;
    },
  };
  return { s, store };
}

export function setup(o: { online?: boolean; result?: LogUploadResult; store?: ReturnType<typeof memStore> } = {}) {
  const st = o.store ?? memStore();
  const sent: LogRow[][] = [];
  let result: LogUploadResult = o.result ?? 'ok';
  let online = o.online ?? true;
  let onlineFn: (() => void) | null = null;
  let tickFn: (() => void) | null = null;
  let clock = 1_000_000;
  let n = 0;
  const warn = vi.fn();
  const q = createLogQueue({
    store: st.store,
    upload: (rows) => {
      sent.push([...rows]);
      return Promise.resolve(result);
    },
    isOnline: () => online,
    onOnline: (fn) => {
      onlineFn = fn;
      return () => {
        onlineFn = null;
      };
    },
    now: () => clock,
    newKey: () => `k${++n}`,
    warn,
    every: (fn) => {
      tickFn = fn;
      return () => {
        tickFn = null;
      };
    },
  });
  return {
    q, st, sent, warn,
    setResult: (r: LogUploadResult) => (result = r),
    setOnline: (v: boolean) => (online = v),
    goOnline: () => onlineFn?.(),
    tick: (ms: number) => {
      clock += ms;
      tickFn?.();
    },
    hasTimer: () => tickFn !== null,
    hasOnline: () => onlineFn !== null,
  };
}

export const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};
export const addN = (q: ReturnType<typeof setup>['q'], n: number, from = 0): void => {
  for (let i = 0; i < n; i++) q.add({ act: `a${from + i}`, t: 100 + from + i });
};
