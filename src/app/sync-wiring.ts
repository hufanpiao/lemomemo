// 把 K8 同步接进入口（main.tsx 调）：选主（platform/tab-leader.ts）只让主页跑同步和 report_tz；页面之间用 BroadcastChannel 提醒（outbox、changed、reset）
// 不变量：只在 boot 正常时接；被移除、停用、冷静期只处理一次（removedHandled），退出交给 core/device-exit.ts 的 exitDevice
// 不变量：account_disabled 先探测、active 限次重新载入、别的标签页发来的退出原因见 app/sync-disabled.ts；新建回 42501 见 app/insert-denied.ts
// 不变量：别的标签页的冷静期 reset 跟着清库（followCooling，不删会话）；已在走“会话没了”的退出时又来 account_disabled，只改记成 disabled
import { wipeLocal } from '../core/account.ts';
import type { AuthLossPath, AuthLossSignal } from '../core/auth-loss.ts';
import { defaultExitDeps, exitDevice, exitStarted, type ExitDeps, type ExitReason } from '../core/device-exit.ts';
import { resolveAuthLossLazy } from '../core/auth-loss-lazy.ts';
import type { BootResult } from '../core/boot.ts';
import { createSync, type Sync, type SyncOptions } from '../core/sync/engine.ts';
import { reloadCollections } from '../core/sync/reload.ts';
import { createTzReporter, type TzReporter } from '../core/sync/report-tz.ts';
import type { SyncState, SyncTransport } from '../core/sync/types.ts';
import { browserLifecycle, onUserActivity, type Lifecycle } from '../platform/net.ts';
import { exitNoticeOf, isSelfSignOut, readExitNotice, type ExitNotice } from '../platform/session.ts';
import { startSyncNotices } from './sync-notice-gate.ts';
import { createInsertDeniedCheck, type InsertDeniedCheck } from './insert-denied.ts';
import { canProbe, currentSid, noLocalSession, noteExitFromOtherTab, probeThenLeave, type SyncDisabledDeps } from './sync-disabled.ts';
import { markReauthDisabled } from '../platform/auth-loss-store.ts';
import { createTabLeader, type SyncMessage, type TabLeader, type TabLeaderOptions } from '../platform/tab-leader.ts';

export { ACTIVE_RELOAD_KEY, ACTIVE_RELOAD_WINDOW_MS } from './sync-disabled.ts';

/** 探测、限次、退出原因那几项（setExitNotice、probeAccount、readSession、reload、reloadMarks、now、onSyncPaused、log）在 SyncDisabledDeps */
export interface WireSyncDeps extends SyncDisabledDeps {
  transport: SyncTransport;
  /** platform/session.ts 的 clearCacheStorage（只删运行时缓存） */
  clearCacheStorage(): Promise<void>;
  /** platform/session.ts 的 clearLocalSessionIf：本机会话还是被拒那次请求用的会话才删（收到事件时、回登录页前各一次） */
  // 返回删没删成（A-1）。这里不看返回值：之后的 goToAuth 按 session-store 的删除状态决定重新载入还是显示“退出没完成，点重试”
  clearLocalSessionIf(sessionId: string | null): Promise<boolean>;
  /** platform/session.ts 的 goToAuth */
  goToAuth(): void;
  /** 测试用：读已记下的退出原因（默认 platform/session.ts 的 readExitNotice） */
  readExitNotice?: () => ExitNotice | null;
  /** 测试用：最近有没有本人退出（本页或别的标签页打的 lemo.self_signout；默认 platform/session.ts 的 isSelfSignOut，R-382 复核建议 ②） */
  isSelfSignOut?: () => boolean;
  /** 本会话的 devices 行 id（登录流程登记设备后才有）；不给或返回 null 时不报时区 */
  deviceId?: () => string | null;
  /** 登记或复用本会话的 devices 行、按天刷新 last_seen_at（core/device-reg.ts 的 ensure）；只在主页调（拿到锁、用户操作、恢复网络） */
  ensureDevice?: () => Promise<string | null>;
  /** devices.platform：ios / windows / web / tauri（默认 web） */
  platform?: string;
  /** 拿到 / 放开同步锁（日志上传队列只在主页传，core/log/queue.ts 的 setLeader）；放开时返回正在进行的上传，放锁前等它 */
  onLeader?: (on: boolean) => void | Promise<void>;
  /** 被移除、停用、注销冷静期退出时停掉并清掉这个账号的日志队列（架构 0.38 第 68 条） */
  clearLogs?: () => void;
  /** 测试用：会话没了怎么定结局（默认 core/auth-loss.ts 的 resolveAuthLoss，R-382） */
  resolveAuthLoss?: (signal: AuthLossSignal) => Promise<'expired' | 'removed'>;
  /** 测试用：换掉 createSync、选主、前后台、用户操作 */
  create?: (boot: BootResult, opts: SyncOptions) => Sync;
  leader?: (o: TabLeaderOptions) => TabLeader;
  lifecycle?: Lifecycle;
  onActivity?: (fn: () => void) => () => void;
}

/** 已停用优先（0.60 复审建议 2）：会话没了的退出已经在走（被移除、登录过期），又收到这个会话的 account_disabled：改记“已停用” */
function notePriorDisabled(boot: BootResult, deps: WireSyncDeps, code: string, sid: string | null): void {
  if (code !== 'account_disabled' || !boot.sessionGone || sid === null) return;
  deps.setExitNotice('disabled', sid);
  // 记号已写成 expired 的，一起改成 disabled（登录页以记号为准，R-382 复核建议 ①）
  markReauthDisabled();
}

/**
 * 退出这台设备交给 core/device-exit.ts，这里只接同步层的几样：广播走选主频道，退出原因按本页规则记——
 * removed、expired 不覆盖已记下的原因（已停用优先）；removed 只在本机会话还是被拒那一个（或已没有）时记（K6-sugg5 ④(c)）
 */
function exitDepsOf(boot: BootResult, deps: WireSyncDeps, post: (m: SyncMessage) => void): ExitDeps {
  const record = (notice: ExitNotice, sid: string | null): void => {
    if ((notice === 'removed' || notice === 'expired') && (deps.readExitNotice ?? readExitNotice)() !== null) return;
    const now = currentSid(deps);
    if (notice === 'removed' && now !== null && now !== sid) return;
    deps.setExitNotice(notice, sid);
  };
  return {
    getBoot: () => boot,
    wipe: (b) => wipeLocal(b, { clearCacheStorage: deps.clearCacheStorage, ...(deps.log ? { log: deps.log } : {}) }),
    keep: defaultExitDeps.keep,
    clearLocalSessionIf: (sid) => deps.clearLocalSessionIf(sid),
    clearLogs: () => deps.clearLogs?.(),
    broadcastReset: (_userId, exit) => post({ type: 'reset', ...exit }),
    goToAuth: (notice, sid) => {
      if (notice) record(notice, sid);
      deps.goToAuth();
    },
    resolveAuthLoss: (signal) => (deps.resolveAuthLoss ?? resolveAuthLossLazy)(signal),
    ...(deps.log ? { log: deps.log } : {}),
  };
}

/** Q-15：新建回 42501 的停用探测（见文件头）；能探测时才有。knownProbe 给 probeThenLeave 沿用探出的结果、不再探第二次 */
function insertDeniedOf(deps: WireSyncDeps): { denied: InsertDeniedCheck | null; deps: WireSyncDeps } {
  if (!canProbe(deps) || !deps.probeAccount || !deps.readSession) return { denied: null, deps };
  const denied = createInsertDeniedCheck({ probe: deps.probeAccount, readSession: deps.readSession, ...(deps.now ? { now: deps.now } : {}) });
  return { denied, deps: { ...deps, knownProbe: (sid) => denied.take(sid) } };
}

const IDLE: SyncState = { syncing: false, realtime: 'down', lastPullAt: null, stopped: false };

/** 对外的 Sync：转给当前主页上的引擎（非主页时是空的）；订阅跨引擎保留 */
function createFacade(current: () => Sync | null, close: () => Promise<void>) {
  const listeners = new Set<() => void>();
  const eventFns = new Set<Parameters<Sync['onEvent']>[0]>();
  const add = <T>(s: Set<T>, x: T): (() => void) => {
    s.add(x);
    return () => {
      s.delete(x);
    };
  };
  const facade: Sync = {
    start: () => undefined,
    stop: () => void close(),
    drain: (ms) => current()?.drain(ms) ?? Promise.resolve(),
    syncNow: () => current()?.syncNow() ?? Promise.resolve(),
    sendNow: () => current()?.sendNow() ?? Promise.resolve(),
    idle: () => current()?.idle() ?? Promise.resolve(),
    getState: () => current()?.getState() ?? IDLE,
    subscribe: (l) => add(listeners, l),
    onEvent: (fn) => add(eventFns, fn),
  };
  /** 新引擎接上：把它的状态和事件转给外面的订阅者 */
  const attach = (s: Sync): (() => void) => {
    const offs = [s.subscribe(() => listeners.forEach((l) => l())), s.onEvent((e) => eventFns.forEach((f) => f(e)))];
    listeners.forEach((l) => l());
    return () => offs.forEach((o) => o());
  };
  return { facade, attach, changed: () => listeners.forEach((l) => l()) };
}

/** 接上同步（按选主启动）；不该接时返回 null */
export function wireSync(boot: BootResult, deps: WireSyncDeps): Sync | null {
  const q15 = insertDeniedOf(deps);
  return wireWith(boot, q15.deps, q15.denied);
}

/** wireSync 的主体；denied 见 insertDeniedOf */
function wireWith(boot: BootResult, deps: WireSyncDeps, denied: InsertDeniedCheck | null): Sync | null {
  const { cache, outbox } = boot;
  if (boot.status !== 'ready' || boot.switching || !cache || !outbox) return null;
  const life = deps.lifecycle ?? browserLifecycle;
  /** 这类事件已经在处理（退出、探测中、限次暂停） */
  let removedHandled = false;
  let leader: TabLeader | null = null;
  const ex = exitDepsOf(boot, deps, (m) => leader?.post(m));
  /** 退出这台设备（core/device-exit.ts：被移除先查 session_fate；停用、过期只退出；冷静期不删会话）；sid：被拒那次请求的会话 */
  const leave = (reason: ExitReason, sid: string | null, path: AuthLossPath = 'outbox', code?: string): void =>
    void exitDevice({ reason, sid, path, ...(code ? { code } : {}) }, ex);
  /** sid：被拒那次请求发出前本机会话的 session_id；path：信号从哪来（lemo.authloss 记录用） */
  const onRemoved = (code: string, sid: string | null, path: AuthLossPath = 'outbox'): void => {
    if (removedHandled || boot.switching) return notePriorDisabled(boot, deps, code, sid);
    removedHandled = true;
    if (code === 'account_disabled' && noLocalSession(deps, sid)) {
      // sid 为 null、本机也没有会话：不探测（R-263），提示“登录已失效”、只退出不清库；会话是别的标签页本人退出删掉的就跟着清库、不提示
      return leave((deps.isSelfSignOut ?? (() => isSelfSignOut()))() ? 'followed' : 'expired', null, path);
    }
    // 限次触发时让出同步主页（这一页的闸关着，占着锁别的标签页就都不同步了）
    if (code === 'account_disabled' && canProbe(deps)) return void probeThenLeave(boot, deps, sid, (r, s) => leave(r, s, path), yieldLeader);
    leave(exitNoticeOf(code), sid, path, code);
  };
  outbox.onEvent((e) => {
    if (e.type === 'removed' || e.type === 'disabled') onRemoved(e.code, e.sid);
  });

  const reporter: TzReporter = createTzReporter({
    transport: deps.transport,
    deviceId: () => deps.deviceId?.() ?? null,
    platform: deps.platform ?? 'web',
    ...(deps.log ? { log: deps.log } : {}),
  });
  let current: Sync | null = null;
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => (closing ??= (async () => {
    await leader?.close();
    current?.stop();
  })());
  const f = createFacade(() => current, close);

  /** 拿到锁：建引擎、启动、报时区；返回放手时调的 stop */
  const lead = (): (() => Promise<void>) => {
    const sync = (deps.create ?? createSync)(boot, {
      transport: deps.transport,
      onRemoved: (code, sid) => onRemoved(code, sid, 'sync'),
      onChanged: (colls) => leader?.post({ type: 'changed', colls }),
      ...(deps.log ? { log: deps.log } : {}), ...(denied ? { insertDenied: denied.check } : {}),
    });
    current = sync;
    const detach = f.attach(sync);
    sync.start();
    /** 报时区：先登记或复用设备行（已登记好时只是读内存，到点才刷新 last_seen_at）；登记期间放手了、在换账号就不报 */
    const tz = async (force: boolean): Promise<void> => {
      if (deps.ensureDevice) {
        await deps.ensureDevice();
        if (current !== sync || boot.switching) return;
      }
      await reporter.report(force);
    };
    void tz(true);
    void deps.onLeader?.(true);
    const offActivity = (deps.onActivity ?? onUserActivity)(() => void tz(false));
    const offOnline = life.onOnline(() => void tz(false));
    return async () => {
      offActivity();
      offOnline();
      // 日志正在传的那一批传完再放锁，免得新主页把同一批再传一遍（上传自带超时，等不久）
      const logsDone = deps.onLeader?.(false);
      await sync.drain();
      await logsDone;
      detach();
      if (current === sync) current = null;
      f.changed();
    };
  };
  /**
   * 别的标签页因冷静期退出（R-263）：那边不删会话（R-262），本页就收不到 storage 事件，得自己走：清库、回登录页，同样不删会话。
   * 主页、非主页都走（设置页、告知页离开时用临时频道发，主页也会收到）；本页已经在走退出流程（boot.switching）就不管。
   * 退出原因上面 noteExitFromOtherTab 已记下；回登录页后 SessionCheck 探测出冷静期，就地出恢复页
   */
  const followCooling = (): void => {
    // 不看 removedHandled：同步暂停时它已设，照样要接手（R-263-sugg ①）
    if (boot.switching) return;
    removedHandled = true;
    leave('followed', null);
  };
  const onMessage = (m: SyncMessage): void => {
    // 别的标签页因被移除、停用、冷静期退出（reset 带 notice）：会话还对得上时记下同一条退出原因（app/sync-disabled.ts）
    noteExitFromOtherTab(m, deps);
    if (m.type === 'reset' && m.notice === 'pending_deletion') return followCooling();
    if (leader?.isLeader()) {
      // 先重读：别的页改的队列本页 outbox 的摘要还不知道（暂停解除、待发数）；refresh 摘要变了引擎自己会 kickSend，
      // 和这里的 sendNow 由引擎的 sendQueued 合并成一次（OUTBOX-cross-tab）。refresh 失败（库已关：换账号、清库中）就不 sendNow：
      // 这时本页的队列已经不能用，发了也是空转；库正常时下一次提醒、定时发送照样会发
      if (m.type === 'outbox') void outbox.refresh().then(() => current?.sendNow()).catch(() => undefined);
      return;
    }
    if (m.type === 'outbox' || boot.switching) return;
    void (async () => {
      await outbox.refresh();
      if (boot.switching) return;
      await reloadCollections(cache, m.type === 'changed' ? m.colls : null, () => boot.switching);
    })().catch(() => undefined);   // 库已关（换账号、清库中）：不管
  };
  // 非主页改了队列（outbox 的 queue 事件：新写入、合并进已排队的项、清退避、重试、丢弃等，待发数不变也算）：提醒主页马上发。
  // 同一轮里的多次合并成一次（OUTBOX-cross-tab）。别的页改的、本页 refresh 读到的不再提醒（那一页自己会提醒）
  let nudging = false;
  outbox.onEvent((e) => {
    if (e.type !== 'queue' || nudging) return;
    nudging = true;
    queueMicrotask(() => {
      nudging = false;
      if (leader && !leader.isLeader() && !boot.switching) leader.post({ type: 'outbox' });
    });
  });
  // 整份重读一次（outbox 待发数、各集合）：库已关（换账号、清库中）时不管
  const rereadAll = (): void => {
    void (async () => {
      await outbox.refresh();
      if (boot.switching) return;
      await reloadCollections(cache, null, () => boot.switching);
    })().catch(() => undefined);
  };
  // 非主页回到前台：整份重读一次兜底（消息可能丢了）
  life.onVisibility((visible) => {
    if (!visible || !leader || leader.isLeader() || boot.switching) return;
    rereadAll();
  });

  const name = `lemo-sync:${boot.userId ?? ''}`;
  const make = deps.leader ?? createTabLeader;
  leader = make({ name, lead, onMessage, ...(deps.log ? { log: deps.log } : {}) });
  // 频道刚建好时补一次（FA-6 推迟启动审查 M3）：wireSync 等首屏画完才跑（main.tsx 的 await appPainted()，最长约 6 秒），
  // 这之前主页发的 changed 本页收不到、本页的写入也没提醒主页。抢锁是异步的，这一刻还不知道自己是不是主页：
  // 一律整份重读一次（主页随后 start 会补拉，多读一次无害）；读完本页 outbox 里还有待发的、又不是主页，提醒一次主页马上发。
  // 读库期间本机新写入、引擎拉进来的行不会被这次重读删掉或改回旧值（reloadCollections 只动读库期间没变过的行，代码复审 N1）。
  // 换账号闸：建频道时、refresh 回来时各看一次（代码复审 N2），闸设上了就不把旧账号的行灌回刚清空的内存
  if (!boot.switching) {
    void (async () => {
      await outbox.refresh();
      if (boot.switching) return;
      // 逐表读的期间也可能设闸（N3）：每张表读完再看一次
      await reloadCollections(cache, null, () => boot.switching);
      if (!boot.switching && leader && !leader.isLeader() && outbox.getStatus().pending > 0) leader.post({ type: 'outbox' });
    })().catch(() => undefined);
  }
  /**
   * 限次触发、同步暂停：让出主页（放锁、关频道），再开一个 listenOnly 的（只收提醒、从不排队抢锁、从不调 lead；
   * 没有 Web Locks 时也不当主页，D3），暂停期间别的标签页的冷静期 reset 照样收得到（R-263-sugg ①）。wireSync 的 close 关的是当前这个。
   * 旧的 close 要等引擎 drain 完才关频道（最长约 20 秒），这段时间同一条消息新旧两个频道各收一次：onMessage 必须保持可以重复执行。
   * 行为变化（TABLEADER-listen）：以前借 NEVER_VISIBLE 时，没有 Web Locks 的页面只听的那个会自己当主页（isLeader() 为 true，
   * lead 是空的）；现在 listenOnly 的 isLeader() 恒为 false，所以暂停页收到 outbox 不再调 current?.sendNow()（current 已为 null，本来就是空操作），
   * 收到 changed、reset 一律走下面“非主页”分支（outbox.refresh() + 重读集合）；outbox 的 queue 事件里非主页改了队列会发 outbox 提醒主页；
   * 回到前台会整份重读兜底。冷静期 reset 照旧先走 followCooling
   */
  function yieldLeader(): void {
    const old = leader;
    void old?.close();
    if (exitStarted(boot) || boot.switching) return;
    leader = make({ name, lead: () => () => Promise.resolve(), onMessage, listenOnly: true });
  }
  // 同步冲突、gone 提示（K8 冲突提示，方案 2.1）：gate 跟着这个块下载，宿主有要显示的才按需下载；换账号、同步停了自己卸掉
  startSyncNotices(f.facade, boot, { log: deps.log });
  return f.facade;
}
