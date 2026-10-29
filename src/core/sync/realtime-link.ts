// Realtime 连接和断线退路（架构 4.3、14.4；0.38 第 58 条以 14.4 为准）。engine.ts 用，只在主页、只在前台跑（4.3b）
// • connect()：先开轮询兜底，再订阅；连上（up）停轮询并补拉一次；断了（down）切到轮询模式
// • 轮询模式：前台每 30 秒增量拉取一次；每 5 分钟重新订阅一次 WebSocket（频道名每次唯一），连上就切回去
// • 每次切换记日志：realtime_fallback（连着 → 断了）、realtime_restore（断了 → 又连上）
//   这次 connect 以后第一次连上走 firstUp（engine.ts 据此和启动那一轮合并）；断了再连上一律补拉
// • disconnect()：切到后台、放手、停下时断开并停轮询
// • 闸设上了（换账号、被移除、停用、库已封存、正在放手）就不连、不轮询、不补拉
// 纯 TS：不准 import React 和任何功能（A1）
import type { RealtimeHandlers, RealtimeStatus, SyncTransport } from './types.ts';

/** 断线时前台每 30 秒增量拉取一次（14.4） */
export const POLL_INTERVAL_MS = 30_000;
/** 断线时每 5 分钟重试一次 WebSocket（14.4） */
export const WS_RETRY_MS = 5 * 60_000;

export interface RealtimeLinkDeps {
  transport: Pick<SyncTransport, 'subscribe'>;
  tables: readonly string[];
  onRow: RealtimeHandlers['onRow'];
  onTombstone: RealtimeHandlers['onTombstone'];
  /** 状态变了（界面用） */
  onStatus(s: RealtimeStatus): void;
  /** 断了再连上时补拉一次、轮询时每次调 */
  pull(): void;
  /** 这次 connect 以后第一次连上（不传就当 pull） */
  firstUp?(): void;
  /** 闸（含已停下）：不再连接、不再轮询 */
  gated(): boolean;
  /** 记日志（act 码，不记内容） */
  log?(code: string): void;
}

export interface RealtimeLink {
  connect(): void;
  disconnect(): void;
}

export function createRealtimeLink(d: RealtimeLinkDeps): RealtimeLink {
  let unsub: (() => void) | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let retry: ReturnType<typeof setInterval> | null = null;
  /** 曾经连上过、现在断了（用来记 fallback / restore） */
  let wasUp = false;
  let fellBack = false;
  let first = true;
  const stopTimers = (): void => {
    if (poll !== null) clearInterval(poll);
    if (retry !== null) clearInterval(retry);
    poll = retry = null;
  };
  const startFallback = (): void => {
    if (d.gated()) return;
    if (poll === null) poll = setInterval(() => (d.gated() ? undefined : d.pull()), POLL_INTERVAL_MS);
    if (retry === null) retry = setInterval(() => resubscribe(), WS_RETRY_MS);
  };
  const subscribe = (): void => {
    const mine: { off: (() => void) | null } = { off: null };
    mine.off = d.transport.subscribe(d.tables, {
      onRow: d.onRow,
      onTombstone: d.onTombstone,
      onStatus: (s) => {
        if (d.gated() || unsub !== mine.off) return;   // 旧频道的回调不理
        d.onStatus(s);
        if (s === 'up') {
          stopTimers();
          if (fellBack) d.log?.('realtime_restore');
          fellBack = false;
          wasUp = true;
          if (first && d.firstUp) d.firstUp();
          else d.pull();   // 重连：补拉断开期间的改动
          first = false;
        } else {
          if (wasUp && !fellBack) d.log?.('realtime_fallback');
          if (wasUp) fellBack = true;
          wasUp = false;
          startFallback();
        }
      },
    });
    unsub = mine.off;
  };
  /** 轮询模式下每 5 分钟：丢掉旧频道，重新订阅（新频道名） */
  const resubscribe = (): void => {
    if (d.gated() || !unsub) return;
    const off = unsub;
    unsub = null;
    off();
    subscribe();
  };
  return {
    connect() {
      if (unsub || d.gated()) return;
      first = true;
      startFallback();   // 连上之前先轮询兜底
      subscribe();
    },
    disconnect() {
      stopTimers();
      const off = unsub;
      unsub = null;
      off?.();
      wasUp = false;
      fellBack = false;
      d.onStatus('down');
    },
  };
}
