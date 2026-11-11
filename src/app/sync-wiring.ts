// 把 K8 同步接进入口（main.tsx 调）：只让主页跑同步（架构 4.3b、0.38 第 58 条），report_tz 也只在主页上报
// • 只在 boot 正常（status === 'ready'、没在换账号）时接；version_too_new、signed_out、unavailable 不接（createSync 本身也会返回空引擎）
// • 选主（platform/tab-leader.ts）：拿到 'lemo-sync:<user_id>' 锁的页面 createSync(...).start()；放手（页面隐藏、关闭）时 drain：
//   断 Realtime、等在途请求（≤ 20 秒）后停下。没有 navigator.locks 时本页自己跑（记 sync_no_locks）
// • 页面之间的提醒（BroadcastChannel）：非主页往 outbox 写了发 outbox，主页收到马上发送；主页写了本机库发 changed，
//   其余页面 outbox.refresh() 并重读这几个集合；清库发 reset。消息只是提醒，非主页回到前台时整份重读一次兜底
// • report_tz（4.6、4.3b）：主页拿到锁、同步启动、本会话的设备行登记好后 report(true)；之后 pointerdown / keydown 调 report()
//   （自带 5 分钟间隔）；重新拿到锁时再 report(true)。设备行 id 由 deps.deviceId 给；还没有时先 deps.ensureDevice()
//   （core/device-reg.ts：登记或复用本会话的 devices 行，0.38 第 62 条④；登记好以后它顺带每天刷新一次 last_seen_at、app_version），
//   登记好了再报，登记不上这次不报（接手清单 K8-tz-device）。恢复网络（online）时也走一遍（登记 60 秒间隔、上报 5 分钟间隔照旧）
// • 被移除只处理一次：同步引擎（刷新令牌失败）和 outbox 的 removed 事件走同一个 onRemoved
//   → 删本机会话 → wipeOnRemoved：设闸 → 清空本机库和运行时缓存 → 关库（原因 'closed'，不触发 versionchange → 重新载入）→ 回登录页
// • 被停用、注销冷静期（outbox 的 disabled 事件：account_disabled、account_pending_deletion）和被移除走同一套（4.3、4.3b、0.29 续第 131 条②；
//   R-382 起已停用改为只退出、不清本机，见文件末尾那条）：
//   设闸 → 清库 → 删会话 → 回登录页；跳转前记下退出原因（platform/session.ts 的 setExitNotice），登录页提示“已停用”或冷静期的恢复入口。
//   页面一定会跳走，不会出现“停在原页、写入被 switching 静默丢掉”
// • 删本机会话只删被拒那次请求用的会话（接手清单 K6-sugg3 ①、K6-sugg4 ①）：“被移除、停用”都来自某个请求的回包，
//   同步层发请求前记下本机会话的 session_id，随事件带回（engine 的 onRemoved(code, sid)、outbox 事件的 sid）。
//   收到事件的同一个同步段里 clearLocalSessionIf(sid)，清完库、回登录页前再 clearLocalSessionIf(sid) 一次——
//   请求在路上、清库那几秒里别的标签页刚登录的新会话（同一账号、别的账号）都不删；旧会话被晚到的令牌刷新写回来时照样删掉。
//   sid 必填（K6-sugg5 ②）：outbox 事件、引擎的 onRemoved 都一定带着，没有“收到那一刻不管是谁都删”的兜底
// • 冷静期不删会话（R-262 K6-pending-s2）：退出原因是 pending_deletion（直接收到 account_pending_deletion，或 account_disabled
//   探测出冷静期）时不调 clearLocalSessionIf——能判断出冷静期，说明被拒那次请求的会话还活着，删它没有安全收益，反而会误伤
//   别的标签页刚登录的同账号 S2。清库、记退出原因、回登录页照旧；登录页 SessionCheck 探测出冷静期就地出恢复页。停用、被移除、不确定不变
// • 已经在走别的退出流程（watchAccount 发现会话没了或换了账号，boot.switching 已设）：不再清第二遍、不再跳第二次
// • 收到 account_disabled 先探测再决定（R-256 ③ 后续）、active 的重新载入限次、别的标签页发来的退出原因怎么记：见 app/sync-disabled.ts
// • 退出时删会话之前先广播 reset，带上退出原因和被拒的 sid（DISABLED-probe-later ②），别的标签页回登录页显示同一条提示
// • 别的标签页发来冷静期 reset（R-263）：followCooling 清库、回登录页。“已在退出”另用 exiting 标记（R-263-sugg ①），不和
//   removedHandled 共用：本页限次触发进了“同步暂停”（removedHandled 已设、没有退出）以后收到冷静期 reset 照样接手；
//   leave、followCooling 都先看 exiting，连收两次只跳一次，和 onRemoved 之间也不会清两遍、跳两次。
//   暂停时让出主页会连频道一起关（TabLeader.close），所以另开一个 listenOnly 的 TabLeader（只收提醒、从不抢锁、从不调 lead），
//   暂停期间的提醒照样收得到
// • followCooling 不自己记退出原因（R-263-sugg ③，有意的）：原因靠前面的 noteExitFromOtherTab，sid 对不上（本页会话已换成别的）
//   时不记，登录页就不提示；这不是漏了——SessionCheck 照样探测出冷静期、就地出恢复页
// • R-382（架构 4.1a 第 1 点 ②）：刷新令牌被拒（引擎的 onRemoved）和 outbox 的 removed 事件（session_revoked）不再直接清库，
//   先设闸、经 core/auth-loss.ts 的 resolveAuthLoss 定结局：removed 照旧 leave('removed')；expired 走 expireLeave——
//   先广播带 expired 的 reset，写 lemo.reauth、关库（不清），再删被拒的那个会话、记退出原因 expired、回登录页
// • 已停用优先（0.60 复审建议 2）：已经在走“会话没了”的退出（boot.sessionGone）时又收到 account_disabled，只把退出原因改记成 disabled
// • 已停用只退出、不清本机（R-382 负责人 11-11 定）：leave('disabled')（探测出已停用、或不能探测时直接按停用）改走 keepLeave——
//   设闸、写 lemo.reauth（session_id 记 null：登录页不查 session_fate，免得停用时被吊销的会话把本机清掉）、只关库，
//   广播带 disabled 的 reset，删被拒的那个会话，记退出原因 disabled、回登录页。写不了记号退回原来的清库。
//   冷静期、探测不出（disabled_unsure）、被移除不变
import { expireThisTab, markExpired, wipeOnRemoved } from '../core/account.ts';
import type { AuthLossPath, AuthLossSignal } from '../core/auth-loss.ts';
import { resolveAuthLossLazy } from '../core/auth-loss-lazy.ts';
import type { BootResult } from '../core/boot.ts';
import type { Cache } from '../core/cache.ts';
import { createSync, type Sync, type SyncOptions } from '../core/sync/engine.ts';
import { reloadCollections } from '../core/sync/reload.ts';
import { createTzReporter, type TzReporter } from '../core/sync/report-tz.ts';
import type { SyncState, SyncTransport } from '../core/sync/types.ts';
import { browserLifecycle, onUserActivity, type Lifecycle } from '../platform/net.ts';
import { exitNoticeOf, readExitNotice, type ExitNotice } from '../platform/session.ts';
import { startSyncNotices } from './sync-notice-gate.ts';
import { canProbe, currentSid, noLocalSession, noteExitFromOtherTab, probeThenLeave, type SyncDisabledDeps } from './sync-disabled.ts';
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

/** 只删被拒的那个会话（K6-sugg3 ①、K6-sugg4 ①）；存储不可用时本来也存不下会话 */
function dropSession(deps: WireSyncDeps, sid: string | null): void {
  try {
    void deps.clearLocalSessionIf(sid);
  } catch {
    // 存储不可用
  }
}

/** 已停用优先（0.60 复审建议 2）：会话没了的退出已经在走（被移除、登录过期），又收到这个会话的 account_disabled：改记“已停用” */
function notePriorDisabled(boot: BootResult, deps: WireSyncDeps, code: string, sid: string | null): void {
  if (code === 'account_disabled' && boot.sessionGone && sid !== null) deps.setExitNotice('disabled', sid);
}

/**
 * 登录过期、已停用（R-382）：记号已写（markExpired / expireThisTab）；只关库不清，广播带原因的 reset，删被拒的那个会话，记退出原因、回登录页。
 * expired 不覆盖已记下的原因；disabled 照记（已停用优先）
 */
function keepAndLeave(cache: Cache, deps: WireSyncDeps, post: (m: SyncMessage) => void, notice: 'expired' | 'disabled', sid: string | null): void {
  try {
    cache.close();
  } catch {
    // 已经关了
  }
  post({ type: 'reset', notice, sid });
  dropSession(deps, sid);
  if (notice === 'disabled' || (deps.readExitNotice ?? readExitNotice)() === null) deps.setExitNotice(notice, sid);
  deps.goToAuth();
}

/**
 * 会话没了（session_revoked、刷新被拒）：先设闸、写 lemo.reauth，同一个同步段里删被拒的那个会话（K6-sugg3 ①），再定结局（R-382）。
 * 写不了记号（存储不可用）：记 auth_loss_store_failed，直接按 removed（退回原来的清库，4.1a 第 7 点）
 */
function markThenResolve(
  boot: BootResult, deps: WireSyncDeps, s: { path: AuthLossPath; code: string; sid: string | null }, done: (r: 'expired' | 'removed') => void,
): void {
  const kept = markExpired(boot, s.sid);
  if (!kept) deps.log?.('auth_loss_store_failed');
  dropSession(deps, s.sid);
  if (!kept) return done('removed');
  const signal: AuthLossSignal = { path: s.path, code: s.code, sessionId: s.sid, userId: boot.userId };
  void (deps.resolveAuthLoss ?? resolveAuthLossLazy)(signal)
    .catch(() => 'expired' as const)
    .then(done);
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
  const { cache, outbox } = boot;
  if (boot.status !== 'ready' || boot.switching || !cache || !outbox) return null;
  const life = deps.lifecycle ?? browserLifecycle;
  let removedHandled = false;
  /** 已经在退出（leave 或 followCooling 走过一次）：只走一次（R-263-sugg ①，见文件头） */
  let exiting = false;
  let leader: TabLeader | null = null;
  /** 清本机、回登录页；sid：被拒那次请求发出前本机会话的 session_id；dropped：收到时已经删过一次会话（R-382 那一路） */
  const leave = (notice: ExitNotice, sid: string | null, dropped = false): void => {
    if (exiting) return;
    // 已停用：只退出、不清本机（见文件头）；写不了记号才往下走原来的清库
    if (notice === 'disabled' && expireThisTab(boot, null)) return keepLeave(sid, 'disabled');
    exiting = true;
    // 先告诉别的标签页退出原因（DISABLED-probe-later ②）：赶在删会话（storage 事件 → 它们的 watchAccount 清库、回登录页）之前发，
    // 那边收到就 setExitNotice，回登录页时显示同一条提示。带上被拒的 sid：那边的会话已换成别的就不记
    leader?.post({ type: 'reset', notice, sid });
    // 同一个同步段里先删本机会话——只删被拒的那个（K6-sugg3 ①、K6-sugg4 ①）；冷静期不删（R-262，见文件头）
    const drop = (): void => (notice === 'pending_deletion' ? undefined : dropSession(deps, sid));
    if (!dropped) drop();
    deps.clearLogs?.();
    void wipeOnRemoved(boot, {
      clearCacheStorage: deps.clearCacheStorage,
      onRemoved: () => {
        // 被移除只作废了那一个会话：本机已是别的标签页刚登录的另一个会话（同账号或别的账号）时不再提示“被移除”，
        // 免得登录页一边显示“当前已登录”一边说这台设备被移除了（K6-sugg5 ④(c)）。停用、冷静期是账号层面的，照记
        const now = currentSid(deps);
        // removed 不覆盖已记下的原因（同 goToAuth 的规则 K6-signedout-sugg ⑤）：例如设置页申请注销后确认不了，已记下 deletion_unsure（代码复查必改）
        const kept = notice === 'removed' && (deps.readExitNotice ?? readExitNotice)() !== null;
        if (!kept && (notice !== 'removed' || now === null || now === sid)) deps.setExitNotice(notice, sid);
        drop();
        deps.goToAuth();
      },
    });
  };
  /**
   * 登录过期、已停用（R-382）：记号已写（markExpired / expireThisTab）；只关库不清，广播带原因的 reset，删被拒的那个会话，记退出原因、回登录页。
   * expired 不覆盖已记下的原因；disabled 照记（已停用优先）
   */
  const keepLeave = (sid: string | null, notice: 'expired' | 'disabled'): void => {
    if (exiting) return;
    exiting = true;
    keepAndLeave(cache, deps, (m) => leader?.post(m), notice, sid);
  };
  /** sid：被拒那次请求发出前本机会话的 session_id；path：信号从哪来（lemo.authloss 记录用） */
  const onRemoved = (code: string, sid: string | null, path: AuthLossPath = 'outbox'): void => {
    if (removedHandled || boot.switching) return notePriorDisabled(boot, deps, code, sid);
    removedHandled = true;
    // sid 为 null、本机也没有会话：不探测（K6-sugg5 审查建议、R-263，见 sync-disabled.ts 文件头）。没带会话的请求 is_active() 按 uid 为空
    // 本来就回 account_disabled，账号并没停用：提示“登录已失效”（R-263 ③），同样只关库、不清、写 lemo.reauth（R-382，主持人 11-11 复核必改）；
    // 写不了记号才退回原来的清库
    if (code === 'account_disabled' && noLocalSession(deps, sid)) return expireThisTab(boot, null) ? keepLeave(null, 'expired') : leave('expired', null);
    if (code === 'account_disabled' && canProbe(deps)) {
      // 限次触发时让出同步主页（这一页的闸关着，占着锁别的标签页就都不同步了）
      return void probeThenLeave(boot, deps, sid, leave, yieldLeader);
    }
    if (exitNoticeOf(code) !== 'removed') return leave(exitNoticeOf(code), sid);
    markThenResolve(boot, deps, { path, code, sid }, (r) => (r === 'removed' ? leave('removed', sid, true) : keepLeave(sid, 'expired')));
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
      ...(deps.log ? { log: deps.log } : {}),
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
    if (exiting || boot.switching) return;
    exiting = true;
    removedHandled = true;
    deps.clearLogs?.();
    void wipeOnRemoved(boot, { clearCacheStorage: deps.clearCacheStorage, onRemoved: () => deps.goToAuth() });
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
    if (exiting || boot.switching) return;
    leader = make({ name, lead: () => () => Promise.resolve(), onMessage, listenOnly: true });
  }
  // 同步冲突、gone 提示（K8 冲突提示，方案 2.1）：gate 跟着这个块下载，宿主有要显示的才按需下载；换账号、同步停了自己卸掉
  startSyncNotices(f.facade, boot, { log: deps.log });
  return f.facade;
}
