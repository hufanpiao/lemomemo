// 把 K8 同步接进入口（main.tsx 调）：只让主页跑同步（架构 4.3b、0.38 第 58 条），report_tz 也只在主页上报
// • 只在 boot 正常（status === 'ready'、没在换账号）时接；version_too_new、signed_out、unavailable 不接（createSync 本身也会返回空引擎）
// • 选主（platform/tab-leader.ts）：拿到 'lemo-sync:<user_id>' 锁的页面 createSync(...).start()；放手（页面隐藏、关闭）时 drain：
//   断 Realtime、等在途请求（≤ 20 秒）后停下。没有 navigator.locks 时本页自己跑（记 sync_no_locks）
// • 页面之间的提醒（BroadcastChannel）：非主页往 outbox 写了发 outbox，主页收到马上发送；主页写了本机库发 changed，
//   其余页面 outbox.refresh() 并重读这几个集合；清库发 reset。消息只是提醒，非主页回到前台时整份重读一次兜底
// • report_tz（4.6、4.3b）：主页拿到锁、同步启动、本会话的设备行登记好后 report(true)；之后 pointerdown / keydown 调 report()
//   （自带 5 分钟间隔）；重新拿到锁时再 report(true)。设备行 id 由 deps.deviceId 给（还没接上时不报，见接手清单 K8-tz-device）
// • 被移除只处理一次：同步引擎（刷新令牌失败）和 outbox 的 removed 事件走同一个 onRemoved
//   → wipeOnRemoved：设闸 → 清空本机库和运行时缓存 → 关库（原因 'closed'，不触发 versionchange → 重新载入）→ 删本机会话、回登录页
// • 被停用、注销冷静期（outbox 的 disabled 事件：account_disabled、account_pending_deletion）和被移除走同一套（4.3、4.3b、0.29 续第 131 条②）：
//   设闸 → 清库 → 删会话 → 回登录页；跳转前记下退出原因（platform/session.ts 的 setExitNotice），登录页提示“已停用”或冷静期的恢复入口。
//   页面一定会跳走，不会出现“停在原页、写入被 switching 静默丢掉”
// • 已经在走别的退出流程（watchAccount 发现会话没了或换了账号，boot.switching 已设）：不再清第二遍、不再跳第二次
import { wipeOnRemoved } from '../core/account.ts';
import type { BootResult } from '../core/boot.ts';
import { createSync, type Sync, type SyncOptions } from '../core/sync/engine.ts';
import { reloadCollections } from '../core/sync/reload.ts';
import { createTzReporter, type TzReporter } from '../core/sync/report-tz.ts';
import type { SyncLog, SyncState, SyncTransport } from '../core/sync/types.ts';
import { browserLifecycle, onUserActivity, type Lifecycle } from '../platform/net.ts';
import { exitNoticeOf, type ExitNotice } from '../platform/session.ts';
import { createTabLeader, type SyncMessage, type TabLeader, type TabLeaderOptions } from '../platform/tab-leader.ts';

export interface WireSyncDeps {
  transport: SyncTransport;
  /** platform/session.ts 的 clearCacheStorage（只删运行时缓存） */
  clearCacheStorage(): Promise<void>;
  /** platform/session.ts 的 clearLocalSession */
  clearLocalSession(): void;
  /** platform/session.ts 的 goToAuth */
  goToAuth(): void;
  /** platform/session.ts 的 setExitNotice：回登录页前记下退出原因 */
  setExitNotice(n: ExitNotice): void;
  /** 本会话的 devices 行 id（登录流程登记设备后才有）；不给或返回 null 时不报时区 */
  deviceId?: () => string | null;
  /** devices.platform：ios / windows / web / tauri（默认 web） */
  platform?: string;
  /** 记日志（act + coll / code，不记内容和服务器原文） */
  log?: SyncLog;
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
  const onRemoved = (code: string): void => {
    if (removedHandled || boot.switching) return;
    removedHandled = true;
    leader?.post({ type: 'reset' });
    void wipeOnRemoved(boot, {
      clearCacheStorage: deps.clearCacheStorage,
      onRemoved: () => {
        deps.setExitNotice(exitNoticeOf(code));
        deps.clearLocalSession();
        deps.goToAuth();
      },
    });
  };
  outbox.onEvent((e) => {
    if (e.type === 'removed' || e.type === 'disabled') onRemoved(e.code);
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
    void reporter.report(true);
    const offActivity = (deps.onActivity ?? onUserActivity)(() => void reporter.report());
    return async () => {
      offActivity();
      await sync.drain();
      detach();
      if (current === sync) current = null;
      f.changed();
    };
  };
  const onMessage = (m: SyncMessage): void => {
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
