// 同步引擎：createSync(boot, opts).start()
// • 所有活（发送、拉取、Realtime 来的行、墓碑）排进同一条串行链（runner.ts），不并发
// • 只在主页上建（app/sync-wiring.ts 拿到锁才 createSync，放手时 drain）；每件活写过的表交给 onChanged（主页广播 changed）
// • 触发时机：启动；上线、切到前台（先清退避，先发后拉——带提醒的条目最先发）；入队后（outbox 状态变了）；每 30 秒发一次；
//   Realtime 连上时补拉一次（这次连接以后已经开始过一轮的就不再补，和启动那一轮合并）；断线时轮询（realtime-link.ts）；
//   conflict / forked / gone 后补拉那张表；服务器拒收（rejected）后整表重拉那张表
// • 前台才连 Realtime；同步表只订阅 INSERT、UPDATE，tombstones 只订阅 INSERT
// • 启动和切到前台时整行刷新 app_config、profiles 本人那一行（applyFreshConfig）
// • 闸：boot.switching、outbox.isSuspended()、库已封存或已关 → 停下（清定时器、断 Realtime），不发、不写回；连 Realtime 前也先看闸；
//   任何一步抛 CacheClosedError 同样停下，不重试、不报错、不记日志（outbox-types.ts 的约定）
// • cache === null 或 outbox === null（本机库打不开、version_too_new、没登录）：安全降级，start() 什么也不做、不抛
// • 挡同步（低于最低版本、426）：不发；拉取照常（只读，服务器的版本闸只挡写入）
// • 被移除：刷新令牌回 session_not_found 等 → 停下并调 onRemoved（main.tsx 和 outbox 的 removed 事件走同一个处理）；
//   刷新后马上又 401 不算被移除（退避重试，记 auth_retry_401）；拉取遇到 401 也刷新一次再拉
// • 串行链有看门狗（runner.ts）：一件活超过 60 秒放行下一件，记 sync_task_timeout
// • 时间用 platform/clock 校正过偏差的（needsFull 的 25 天、lastPullAt）
// 纯 TS：不准 import React 和任何功能
import { SCHEMA_V } from '../../../shared/schema/rows.ts';
import { clock } from '../../platform/clock.ts';
import { browserLifecycle, type Lifecycle } from '../../platform/net.ts';
import type { BootResult } from '../boot.ts';
import type { Cache } from '../cache.ts';
import type { Outbox } from '../outbox-types.ts';
import { createParseRows, type ReadLog } from '../read/lenient.ts';
import { createHub, inertSync, type Hub, type Sync } from './hub.ts';
import { applyRealtimeRow, applyRealtimeTombstone, pullTable, type PullDeps } from './pull.ts';
import { createRealtimeLink, type RealtimeLink } from './realtime-link.ts';
import { pullRound, retryDelay, trackTables, type RoundCtx } from './round.ts';
import { createRunner, type Runner } from './runner.ts';
import { refreshFlow, sendAll } from './send.ts';
import type { ParseServerRows, SyncLog, SyncTransport } from './types.ts';

export type { Sync } from './hub.ts';

export const SEND_INTERVAL_MS = 30_000;
/** 放手时最多等正在跑的那件活这么久（单请求超时） */
export const DRAIN_TIMEOUT_MS = 20_000;

export interface SyncOptions {
  transport: SyncTransport;
  /** 宽容读取；默认 read/lenient.ts 的 createParseRows（测试可换） */
  parseRows?: ParseServerRows;
  /** 被移除（刷新令牌失败）：清本机、删本机会话、回登录页。只调一次。sid：被拒那次请求发出前本机会话的 session_id */
  onRemoved(code: string, sid: string | null): void;
  /** 一件活写过本机库的这些表（主页据此给别的页面发 changed） */
  onChanged?(tables: readonly string[]): void;
  lifecycle?: Lifecycle;
  now?: () => number;
  /** 记日志（act + coll / code，不记内容和服务器原文）；日志层接上以前不传 */
  log?: SyncLog;
  schemaV?: number;
  /** 测试用：不刷新 app_config / profiles */
  skipConfig?: boolean;
  /** 测试用：串行链看门狗（默认 runner.ts 的 60 秒） */
  taskTimeoutMs?: number;
  /** 新建回 403、42501 时探测账号是不是已停用（send.ts 的 SendDeps.insertDenied）；app/sync-wiring.ts 给 */
  insertDenied?(sid: string | null): Promise<boolean>;
}

/** createSync 里各部分共用的东西 */
interface Ctx {
  boot: BootResult;
  cache: Cache;
  outbox: Outbox;
  opts: SyncOptions;
  hub: Hub;
  runner: Runner;
  /** 排一件活（放手中不再排新的；跑完把写过的表交给 onChanged） */
  /** 排进串行链；what 是看门狗日志里的名字（runner.ts） */
  run(task: () => Promise<void>, what: string): Promise<void>;
  d: PullDeps;
  round: RoundCtx;
  gated(): boolean;
  isStopped(): boolean;
  /** 闸设上了但只是放手（drain、停下；没封存、没换账号）：send 把在途的项改回 pending */
  released(): boolean;
  removed(code: string, sid: string | null): void;
  now(): number;
}

/** 拉取：整轮（合并重复的）、单表、遇 401 刷新一次 */
function createPulls(c: Ctx) {
  let pullQueued = false;
  let roundsStarted = 0;
  const roundWithAuth = async (): Promise<void> => {
    roundsStarted++;
    const ctx: RoundCtx = { ...c.round, withConfig: c.round.withConfig && !c.opts.skipConfig };
    c.round.withConfig = false;
    let r = await pullRound(ctx, c.opts.transport);
    if (r === 'auth' && !c.gated()) {
      const f = await refreshFlow(c.opts.transport, c.opts.log);
      if (c.gated()) return;
      if (f.kind === 'lost') return c.removed(f.code, f.sid);   // 会话没了：sync-wiring 经 resolveAuthLoss 定结局
      if (f.kind === 'ok') r = await pullRound(ctx, c.opts.transport);
    }
    if (ctx.withConfig) c.round.withConfig = true;   // config 没拉成功的留到下一轮
    if (r === 'ok') c.hub.setState({ lastPullAt: c.now() });
  };
  const pullAll = (): Promise<void> => {
    if (pullQueued || c.isStopped()) return c.runner.tail();
    pullQueued = true;
    return c.run(
      () =>
        c.hub.busy(async () => {
          pullQueued = false;
          await roundWithAuth();
        }),
      'pull',
    );
  };
  const touched = new Set<string>();
  /** 只拉这一张（conflict、forked、gone 之后；服务器拒收之后整表） */
  const pullTableSoon = (table: string): void => {
    if (touched.has(table) || c.isStopped()) return;
    touched.add(table);
    void c.run(async () => {
      touched.delete(table);
      if ((await pullTable(c.d, table, c.round.pendingFull.has(table))) === 'ok') c.round.pendingFull.delete(table);
    }, `pull:${table}`);
  };
  return { pullAll, pullTableSoon, roundsStarted: () => roundsStarted, queued: () => pullQueued };
}

/** 发送：合并重复的触发，退避中的项到点再发 */
function createSender(c: Ctx, tracked: Outbox, pullTableSoon: (t: string) => void) {
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let sendQueued = false;
  const clearRetry = (): void => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };
  const scheduleRetry = async (): Promise<void> => {
    clearRetry();
    const wait = await retryDelay(c.outbox, c.now());
    if (wait === null || c.isStopped()) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void kickSend();
    }, wait);
  };
  const kickSend = (): Promise<void> => {
    if (sendQueued || c.isStopped()) return c.runner.tail();
    sendQueued = true;
    return c.run(
      () =>
        c.hub.busy(async () => {
          sendQueued = false;
          const out = await sendAll({
            outbox: tracked, transport: c.opts.transport, gated: c.gated, emit: c.hub.emit, removed: c.removed, touched: pullTableSoon,
            blocked: () => c.boot.upgrade.getState().syncBlocked !== null, released: c.released, now: c.now,
            ...(c.opts.log ? { log: c.opts.log } : {}),
            ...(c.opts.insertDenied ? { insertDenied: c.opts.insertDenied } : {}),
          });
          if (out === 'retry') await scheduleRetry();
          if (out === 'more') queueMicrotask(() => void kickSend());   // 一批发满了：排到链尾接着发，中间让拉取、Realtime 插进来
        }),
      'send',
    );
  };
  return { kickSend, clearRetry };
}

/**
 * 宽容读取丢掉的行（row_unknown：表名、id、出问题的列名、原因码，不含内容）也走同步的 log，
 * 不然整行被丢时运行日志里一个字都没有
 */
function readLogOf(log: SyncLog | undefined): { log?: (e: ReadLog) => void } {
  if (!log) return {};
  return { log: (e) => log(e.act, { coll: e.coll, code: e.code, fields: e.fields, ...(e.item_id ? { itemId: e.item_id } : {}) }) };
}

export function createSync(boot: BootResult, opts: SyncOptions): Sync {
  const cache = boot.cache;
  const outbox = boot.outbox;
  if (!cache || !outbox || boot.status !== 'ready') return inertSync();
  const life = opts.lifecycle ?? browserLifecycle;
  const now = opts.now ?? (() => clock.now());
  const hub = createHub();
  let started = false;
  let stopped = false;
  let draining = false;
  let removedCalled = false;
  const sealed = (): boolean => boot.switching || outbox.isSuspended() || cache.isClosed() || cache.isSealed();
  const gated = (): boolean => stopped || sealed();
  let sendTimer: ReturnType<typeof setInterval> | null = null;
  const offs: (() => void)[] = [];
  let link: RealtimeLink | null = null;
  let sender: ReturnType<typeof createSender> | null = null;
  const stopTimers = (): void => {
    clearInterval(sendTimer ?? undefined);
    sendTimer = null;
    sender?.clearRetry();
    link?.disconnect();
    for (const off of offs.splice(0)) off();
  };
  const halt = (): void => {
    if (hub.getState().stopped) return;
    stopped = true;
    stopTimers();
    hub.setState({ stopped: true, syncing: false });
  };
  const removed = (code: string, sid: string | null): void => {
    halt();
    if (!removedCalled) opts.onRemoved(code, sid);
    removedCalled = true;
  };
  const runner = createRunner(gated, halt, opts.log, opts.taskTimeoutMs);
  const written = new Set<string>();
  const tracked = trackTables(outbox, written);
  const run = (task: () => Promise<void>, what: string): Promise<void> =>
    runner.run(async () => {
      if (draining) return;
      try {
        await task();
      } finally {
        if (written.size && opts.onChanged) opts.onChanged([...written]);
        written.clear();
      }
    }, what);
  const d: PullDeps = { cache, outbox: tracked, transport: opts.transport, parseRows: opts.parseRows ?? createParseRows(readLogOf(opts.log)), gated, now };
  if (opts.log) d.log = opts.log;
  const round: RoundCtx = {
    boot, cache, d, schemaV: opts.schemaV ?? SCHEMA_V, withConfig: false, refetch: { done: false },
    pendingFull: new Set(boot.fullResync.filter((t) => cache.syncTables.includes(t))),
  };
  const c: Ctx = {
    boot, cache, outbox, opts, hub, runner, run, d, round, gated, isStopped: () => stopped || draining, removed, now,
    released: () => (stopped || draining) && !sealed(),
  };
  const pulls = createPulls(c);
  sender = createSender(c, tracked, pulls.pullTableSoon);
  const { kickSend } = sender;
  const { pullAll } = pulls;

  // ───── Realtime ─────
  let roundsAtConnect = 0;
  link = createRealtimeLink({
    transport: opts.transport,
    tables: cache.syncTables,
    gated: () => gated() || draining,
    pull: () => void pullAll(),
    firstUp: () => {
      if (pulls.roundsStarted() > roundsAtConnect || pulls.queued()) return;   // 合并：连接以后已经开始或已排着一轮
      void pullAll();
    },
    onStatus: (s) => hub.setState({ realtime: s }),
    onRow: (table, raw) => void run(() => applyRealtimeRow(d, table, raw), `rt:${table}`),
    onTombstone: (raw) => void run(() => applyRealtimeTombstone(d, raw), 'rt:tomb'),
    ...(opts.log ? { log: opts.log } : {}),
  });
  /** 连 Realtime 之前先看闸：设上了就停下，不订阅 */
  const connect = (): void => {
    if (gated()) return halt();
    if (draining) return;
    roundsAtConnect = pulls.roundsStarted();
    link?.connect();
  };
  const wake = (withConfig: boolean): void => {
    if (stopped || draining) return;
    if (withConfig) round.withConfig = true;
    // 故意把所有 pending 的 next_at 清成 0，包括 try_later 退避中的项：所有临时故障一致处理；
    // 只由用户切回前台或网络恢复触发，重试频率取决于用户操作、不会自行循环。
    // meta 的 try_later_streak 不清：每撞一次 try_later，streak 加一、之后等得更久
    void run(() => outbox.clearBackoff(), 'clear-backoff');
    void kickSend();
    void pullAll();
  };
  const listen = (): void => {
    offs.push(outbox.subscribe(() => void kickSend()));
    offs.push(
      outbox.onEvent((e) => {
        if (e.type === 'removed' || e.type === 'disabled') halt();   // main.tsx / sync-wiring 已接 outbox 的事件
        else if (e.type === 'rejected') {
          // 拒收码进 code；patch_bad_args 已由 send.ts 记 sync_patch_bad_args（带 sqlstate），这里不重复记
          if (e.code !== 'patch_bad_args') opts.log?.('outbox_rejected', { coll: e.item.table, code: e.code });
          if (e.code === 'purged') return;   // 墓碑、整表重拉删掉的（dropServer）：服务器上这一行已经没了，不用再拉
          round.pendingFull.add(e.item.table);   // vault_required、settings_key_immutable、not_found：整表重拉这张表
          pulls.pullTableSoon(e.item.table);
        }
      }),
    );
    offs.push(life.onOnline(() => wake(false)));
    offs.push(
      life.onVisibility((visible) => {
        if (stopped) return;
        if (visible) {
          wake(true);
          connect();
        } else link?.disconnect();
      }),
    );
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      if (gated()) return halt();
      listen();
      sendTimer = setInterval(() => void kickSend(), SEND_INTERVAL_MS);
      round.withConfig = true;
      void run(() => outbox.resetInflight(), 'reset-inflight');   // 拿到主页身份：上一个主页 drain 超时、崩溃留下的 inflight 改回 pending
      void kickSend();
      void pullAll();
      if (life.isVisible()) connect();
    },
    stop: halt,
    async drain(ms = DRAIN_TIMEOUT_MS) {
      if (stopped) return;
      draining = true;
      stopTimers();
      let timer: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([runner.idle(), new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
      if (timer !== null) clearTimeout(timer);
      halt();
    },
    syncNow: async () => {
      if (stopped || draining) return;
      await kickSend();
      await pullAll();
    },
    sendNow: () => (stopped || draining ? Promise.resolve() : kickSend()),
    idle: () => runner.idle(),
    getState: hub.getState,
    subscribe: hub.subscribe,
    onEvent: hub.onEvent,
  };
}
