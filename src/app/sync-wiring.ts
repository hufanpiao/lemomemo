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
// • 被停用、注销冷静期（outbox 的 disabled 事件：account_disabled、account_pending_deletion）和被移除走同一套（4.3、4.3b、0.29 续第 131 条②）：
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
import { wipeOnRemoved } from '../core/account.ts';
import type { BootResult } from '../core/boot.ts';
import { createSync, type Sync, type SyncOptions } from '../core/sync/engine.ts';
import { reloadCollections } from '../core/sync/reload.ts';
import { createTzReporter, type TzReporter } from '../core/sync/report-tz.ts';
import type { SyncState, SyncTransport } from '../core/sync/types.ts';
import { browserLifecycle, onUserActivity, type Lifecycle } from '../platform/net.ts';
import { exitNoticeOf, type ExitNotice } from '../platform/session.ts';
import { canProbe, currentSid, noLocalSession, noteExitFromOtherTab, probeThenLeave, type SyncDisabledDeps } from './sync-disabled.ts';
import { createTabLeader, type SyncMessage, type TabLeader, type TabLeaderOptions } from '../platform/tab-leader.ts';

export { ACTIVE_RELOAD_KEY, ACTIVE_RELOAD_WINDOW_MS } from './sync-disabled.ts';

/** 探测、限次、退出原因那几项（setExitNotice、probeAccount、readSession、reload、reloadMarks、now、onSyncPaused、log）在 SyncDisabledDeps */
export interface WireSyncDeps extends SyncDisabledDeps {
  transport: SyncTransport;
  /** platform/session.ts 的 clearCacheStorage（只删运行时缓存） */
  clearCacheStorage(): Promise<void>;
  /** platform/session.ts 的 clearLocalSessionIf：本机会话还是被拒那次请求用的会话才删（收到事件时、回登录页前各一次） */
  clearLocalSessionIf(sessionId: string | null): void;
  /** platform/session.ts 的 goToAuth */
  goToAuth(): void;
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
  /** 测试用：换掉 createSync、选主、前后台、用户操作 */
  create?: (boot: BootResult, opts: SyncOptions) => Sync;
  leader?: (o: TabLeaderOptions) => TabLeader;
  lifecycle?: Lifecycle;
  onActivity?: (fn: () => void) => () => void;
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
  let leader: TabLeader | null = null;
  /** 清本机、回登录页；sid：被拒那次请求发出前本机会话的 session_id */
  const leave = (notice: ExitNotice, sid: string | null): void => {
    // 先告诉别的标签页退出原因（DISABLED-probe-later ②）：赶在删会话（storage 事件 → 它们的 watchAccount 清库、回登录页）之前发，
    // 那边收到就 setExitNotice，回登录页时显示同一条提示。带上被拒的 sid：那边的会话已换成别的就不记
    leader?.post({ type: 'reset', notice, sid });
    // 同一个同步段里先删本机会话——只删被拒的那个（K6-sugg3 ①、K6-sugg4 ①）；冷静期不删（R-262，见文件头）
    const drop = (): void => {
      if (notice === 'pending_deletion') return;
      try {
        deps.clearLocalSessionIf(sid);
      } catch {
        // 存储不可用：本来也存不下会话
      }
    };
    drop();
    deps.clearLogs?.();
    void wipeOnRemoved(boot, {
      clearCacheStorage: deps.clearCacheStorage,
      onRemoved: () => {
        // 被移除只作废了那一个会话：本机已是别的标签页刚登录的另一个会话（同账号或别的账号）时不再提示“被移除”，
        // 免得登录页一边显示“当前已登录”一边说这台设备被移除了（K6-sugg5 ④(c)）。停用、冷静期是账号层面的，照记
        const now = currentSid(deps);
        if (notice !== 'removed' || now === null || now === sid) deps.setExitNotice(notice, sid);
        drop();
        deps.goToAuth();
      },
    });
  };
  /** sid：被拒那次请求发出前本机会话的 session_id */
  const onRemoved = (code: string, sid: string | null): void => {
    if (removedHandled || boot.switching) return;
    removedHandled = true;
    // sid 为 null、本机也没有会话：不是账号出了问题，按“登录已失效，请重新登录”退出（K6-sugg5 审查建议、R-263，见 sync-disabled.ts 文件头）
    if (code === 'account_disabled' && noLocalSession(deps, sid)) return leave('expired', null);
    if (code === 'account_disabled' && canProbe(deps)) {
      // 限次触发时让出同步主页（这一页的闸关着，占着锁别的标签页就都不同步了）
      return void probeThenLeave(boot, deps, sid, leave, () => void leader?.close());
    }
    leave(exitNoticeOf(code), sid);
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
      onRemoved,
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
    if (removedHandled || boot.switching) return;
    removedHandled = true;
    deps.clearLogs?.();
    void wipeOnRemoved(boot, { clearCacheStorage: deps.clearCacheStorage, onRemoved: () => deps.goToAuth() });
  };
  const onMessage = (m: SyncMessage): void => {
    // 别的标签页因被移除、停用、冷静期退出（reset 带 notice）：会话还对得上时记下同一条退出原因（app/sync-disabled.ts）
    noteExitFromOtherTab(m, deps);
    if (m.type === 'reset' && m.notice === 'pending_deletion') return followCooling();
    if (leader?.isLeader()) {
      if (m.type === 'outbox') void current?.sendNow();
      return;
    }
    if (m.type === 'outbox' || boot.switching) return;
    void (async () => {
      await outbox.refresh();
      await reloadCollections(cache, m.type === 'changed' ? m.colls : null);
    })().catch(() => undefined);   // 库已关（换账号、清库中）：不管
  };
  // 非主页往 outbox 写了：提醒主页马上发
  outbox.subscribe(() => {
    if (leader && !leader.isLeader() && !boot.switching) leader.post({ type: 'outbox' });
  });
  // 非主页回到前台：整份重读一次兜底（消息可能丢了）
  life.onVisibility((visible) => {
    if (!visible || !leader || leader.isLeader() || boot.switching) return;
    void (async () => {
      await outbox.refresh();
      await reloadCollections(cache, null);
    })().catch(() => undefined);
  });

  leader = (deps.leader ?? createTabLeader)({
    name: `lemo-sync:${boot.userId ?? ''}`,
    lead,
    onMessage,
    ...(deps.log ? { log: deps.log } : {}),
  });
  return f.facade;
}
