// 多个标签页只让一个页面跑同步（架构 4.3b、0.38 第 58 条）：选主、交接、页面之间的提醒。只管锁和频道，不认识同步
// • 选主：navigator.locks.request('lemo-sync:<user_id>', {mode: 'exclusive'})，拿到锁的是主页，持有到放手为止
// • 只在前台排队抢锁：页面隐藏时主页主动放手（先调 lead() 返回的 stop：断 Realtime、等在途请求 ≤ 20 秒），排队中的撤掉；
//   重新显示时再排队（iPhone 冻结的后台页不会一直占着锁）。页面关掉或崩溃时浏览器自动放锁，排队的页面自动拿到
// • 提醒：BroadcastChannel('lemo-sync:<user_id>')，消息 outbox / changed / reset 只是提醒，真相在 IndexedDB
// • 兜底：没有 navigator.locks（某些内嵌浏览器）：这个页面自己当主页（回到 0.38 以前的做法），记一次 sync_no_locks；
//   没有 BroadcastChannel：不发提醒（回到前台整份重读兜底）
// • 只听（listenOnly，TABLEADER-listen）：只开频道收提醒、能发提醒，从不排队抢锁、从不调 lead；isLeader() 恒为 false，
//   没有 Web Locks 时也一样（D3：只听页一律不当主页，也不记 sync_no_locks）。用于同步暂停后让出主页的页面（app/sync-wiring.ts）
// 纯 TS：不准 import React（A1）
import type { ExitNotice } from './session.ts';

/** 页面之间的提醒（4.3b） */
export type SyncMessage =
  /** 非主页往 outbox 写了：主页马上发送 */
  | { type: 'outbox' }
  /** 主页把服务器的变化写进了本机库：其余页面重读这几个集合 */
  | { type: 'changed'; colls: readonly string[] }
  /**
   * 整表重拉、清库：其余页面整份重读。
   * 因被移除、停用、冷静期退出时带 notice（退出原因）和 sid（被拒那次请求的会话）：收到的页面先记下同一条退出原因再走自己的退出流程
   * （DISABLED-probe-later ②）；值不认识的 notice 收到时丢掉，当普通 reset
   */
  | { type: 'reset'; notice?: ExitNotice; sid?: string | null };

/** 用到的 Web Locks 部分（测试可换假的） */
export interface LocksLike {
  request(name: string, options: { mode: 'exclusive'; signal?: AbortSignal }, cb: () => Promise<void>): Promise<unknown>;
}

/** 用到的 BroadcastChannel 部分 */
export interface ChannelLike {
  postMessage(m: unknown): void;
  close(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
}

export interface TabLeaderOptions {
  /** 'lemo-sync:' + user_id */
  name: string;
  /** 拿到锁：开始跑同步；返回放手时调的 stop（断 Realtime、等在途请求，最多 20 秒）。listenOnly 时从不调用 */
  lead(): () => Promise<void>;
  /** 别的页面发来的提醒 */
  onMessage(m: SyncMessage): void;
  /**
   * 只听：只收提醒（post 照样能发），从不排队抢锁、从不调 lead、不看可见性；isLeader() 恒为 false，
   * 没有 Web Locks 时也不自己当主页、不记 sync_no_locks（D3）。close() 只关频道
   */
  listenOnly?: boolean;
  /** 记日志（act 码） */
  log?(code: string): void;
  /** 测试用：换掉 navigator.locks、BroadcastChannel、可见性 */
  locks?: LocksLike | null;
  channel?: (name: string) => ChannelLike | null;
  visibility?: { isVisible(): boolean; onChange(fn: (visible: boolean) => void): () => void };
}

export interface TabLeader {
  isLeader(): boolean;
  /**
   * 发提醒给别的页面。BroadcastChannel 只是“发消息的那个频道对象”自己收不到：本页另开的同名频道（postSyncMessage、
   * 另一个 TabLeader）照样会收到，收消息的一方要按“可能是本页发的”处理（SETTINGS-sugg ⑤）
   */
  post(m: SyncMessage): void;
  /** 退出登录、换账号：放手并关频道 */
  close(): Promise<void>;
}

const isMessage = (v: unknown): v is SyncMessage => {
  if (typeof v !== 'object' || v === null) return false;
  const t = (v as { type?: unknown }).type;
  if (t === 'outbox') return true;
  if (t === 'reset') {
    // notice、sid 类型不对：去掉这两项，当普通 reset（真相在 IndexedDB，提醒本身照样有用）；notice 的取值由收的一方再核对
    const r = v as { notice?: unknown; sid?: unknown };
    if (r.notice !== undefined && typeof r.notice !== 'string') delete r.notice;
    if (r.sid !== undefined && r.sid !== null && typeof r.sid !== 'string') delete r.sid;
    return true;
  }
  return t === 'changed' && Array.isArray((v as { colls?: unknown }).colls);
};

function defaultLocks(): LocksLike | null {
  const n = typeof navigator !== 'undefined' ? (navigator as { locks?: LocksLike }).locks : undefined;
  return n && typeof n.request === 'function' ? n : null;
}

function defaultChannel(name: string): ChannelLike | null {
  return typeof BroadcastChannel === 'function' ? (new BroadcastChannel(name) as unknown as ChannelLike) : null;
}

const docVisibility = {
  isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  onChange(fn: (visible: boolean) => void): () => void {
    if (typeof document === 'undefined') return () => undefined;
    const h = (): void => fn(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  },
};

/** 发提醒：频道已关时提醒丢了不要紧（真相在 IndexedDB） */
const postOn = (ch: ChannelLike | null, m: SyncMessage): void => {
  try {
    ch?.postMessage(m);
  } catch {
    // 频道已关或不能克隆：吞掉
  }
};

export function createTabLeader(o: TabLeaderOptions): TabLeader {
  const ch = (o.channel ?? defaultChannel)(o.name);
  const onmessage = (e: { data: unknown }): void => (isMessage(e.data) ? o.onMessage(e.data) : undefined);
  if (o.listenOnly) {
    // 只听：放在看 locks 之前单独走，不排队、不订阅可见性、不调 lead、不记 sync_no_locks（D3）
    if (ch) ch.onmessage = onmessage;
    let shut = false;
    return {
      isLeader: () => false,
      post: (m) => postOn(ch, m),
      async close() {
        if (shut) return;
        shut = true;
        ch?.close();
      },
    };
  }
  const locks = o.locks === undefined ? defaultLocks() : o.locks;
  const vis = o.visibility ?? docVisibility;
  let leader = false;
  let closed = false;
  /** 正在排队或持有锁：abort 撤掉排队；release 放掉持有的锁 */
  let waiting: AbortController | null = null;
  let release: (() => void) | null = null;
  let held: Promise<void> | null = null;

  if (ch) ch.onmessage = onmessage;

  /** 持有锁期间：跑同步，等到放手 */
  const hold = async (): Promise<void> => {
    waiting = null;
    if (closed || !vis.isVisible()) return;   // 拿到时已经隐藏或关了：马上放掉
    leader = true;
    const stop = o.lead();
    await new Promise<void>((r) => (release = r));
    release = null;
    try {
      await stop();
    } finally {
      leader = false;
    }
  };
  const queue = (): void => {
    if (!locks || closed || waiting || held) return;
    const ac = new AbortController();
    waiting = ac;
    held = Promise.resolve(locks.request(o.name, { mode: 'exclusive', signal: ac.signal }, hold))
      .catch(() => undefined)   // 撤掉排队时 request 以 AbortError 结束
      .then(() => {
        held = null;
        if (waiting === ac) waiting = null;
        if (!closed && vis.isVisible()) queue();   // 放手以后又回到前台了：重新排队
      });
  };
  const letGo = async (): Promise<void> => {
    waiting?.abort();
    waiting = null;
    release?.();
    await held;
  };

  let offVis: () => void = () => undefined;
  if (!locks) {
    // 没有 Web Locks：自己跑同步（不选主），记一次
    o.log?.('sync_no_locks');
    leader = true;
    const stop = o.lead();
    held = new Promise<void>((r) => (release = r)).then(() => stop()).finally(() => {
      leader = false;
    });
  } else {
    offVis = vis.onChange((visible) => {
      if (visible) queue();
      else void letGo();
    });
    if (vis.isVisible()) queue();
  }

  return {
    isLeader: () => leader,
    post: (m) => postOn(ch, m),
    async close() {
      if (closed) return;
      closed = true;
      offVis();
      await letGo();
      ch?.close();
    },
  };
}

/** 页面之间的频道名（和锁同名）：'lemo-sync:' + user_id */
export const syncChannelName = (userId: string): string => `lemo-sync:${userId}`;

/**
 * 不当主页、也不选主时发一条提醒（设置页注销后清完本机库发 reset，R-256 ⑤）：临时开频道、发完就关。
 * 临时频道是另一个对象，所以本页的 TabLeader（同名频道）也会收到这条（SETTINGS-sugg ⑤），不只是别的页面。
 * 没有 BroadcastChannel、发不出去都不抛（提醒丢了不要紧，别的页面回到前台整份重读兜底）
 */
export function postSyncMessage(name: string, m: SyncMessage, channel: (name: string) => ChannelLike | null = defaultChannel): void {
  let ch: ChannelLike | null = null;
  try {
    ch = channel(name);
    ch?.postMessage(m);
  } catch {
    // 同上
  } finally {
    try {
      ch?.close();
    } catch {
      // 已关
    }
  }
}
