// 同步冲突、gone 提示的 gate（K8 冲突提示，方案 docs/09-路线图/B2-K8-冲突提示-实现方案.md 2.1、4.1、4.2、4.4）
// • 跟着 after-paint 块下载（sync-wiring.ts 的 wireSync 末尾调 startSyncNotices），首屏 0 字节；宿主（features/sync-notice 的
//   SyncNoticeHost：卡片、对话框、文案、字段描述）是单独分包，有要显示的东西了才下载、挂上，之后一直挂着
// • 预建容器 <div data-sync-notice role="region">，里面先放常驻的空 role="status" aria-live="polite"（M3），再放宿主的挂载点；
//   宿主不重建 live region，只往里写字。容器的 aria-label 由宿主挂上后按界面语言补（gate 不放文字，A20）
// • 排队、合并、刚恢复的认法在 sync-notice-store.ts；这里只管容器、订阅和挂宿主
// • 收集（4.1）：facade.onEvent 收 conflict / forked，按 table:id 合并（conflicts 取并集、old 逐列取最新）；
//   gone 从 outbox.list() 读 failed && error === 'gone' 的项，按记录分组（H1），读的时机：启动、outbox.subscribe 通知、gone 事件、回到前台（L6）
// • 出卡表白名单（H2）：名单外的 conflict 不出卡；名单外的 gone 静默 resolveGone(..., 'drop')，记 sync_gone_drop（只记 coll）；
//   合并后 undone === true 的 gone（M1）同样 drop，不出卡
// • 刚恢复的那一项按 resolveGone 返回的 opId 认（4.4，复审四 L1），直到它被确认或丢弃（连续两次读队列都不在才不再认）：
//   回 conflict 时去掉 deleted_at、undone，剩下为空不出卡；回 forked 直接不出卡（P1）；
//   outbox 事件 rejected / not_found 出一句“这条已彻底删除，无法恢复。”轻提示（P2，宿主画、经 live region 播报）
// • 换账号（boot.switching；被移除、停用、冷静期的退出也先设它）：卸载宿主、清空队列、移除容器、退订。不跟同步引擎的 stopped（标签页隐藏放锁时就是 stopped）
// • 写入只经 core/write-gone.ts 的 resolveGone（按需下载，M2）；宿主出错由 ErrorBoundary 吞掉，记 js_error（同 RemindHost）
import { createElement, Suspense, type ComponentType, type FC, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BootResult } from '../core/boot.ts';
import type { Sync } from '../core/sync/engine.ts';
import type { SyncLog } from '../core/sync/types.ts';
import { SyncNoticeHost, type SyncNoticeHostProps } from '../features/sync-notice/index.ts';
import { JS_ERROR_ACT, jsErrorCode } from '../platform/env.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { createNoticeStore, forkSuffixOf, type NoticeStoreDeps, type Row } from './sync-notice-store.ts';

/** createElement 的写法要求 children 走第三个参数（react/no-children-prop），类型上把 children 放成可选 */
const Boundary = ErrorBoundary as unknown as FC<{ fallback: null; onError(e: unknown): void; children?: ReactNode }>;

export interface SyncNoticeOptions {
  log?: SyncLog | undefined;
  /** 测试用：换掉 resolveGone（默认按需下载 core/write-gone.ts） */
  resolveGone?: NoticeStoreDeps['resolveGone'];
  /** 测试用：换掉宿主组件 */
  host?: ComponentType<SyncNoticeHostProps>;
}

const lazyResolveGone: NoticeStoreDeps['resolveGone'] = (table, id, mode) =>
  import('../core/write-gone.ts').then((m) => m.resolveGone(table, id, mode));

/**
 * 接上提示（wireSync 末尾调）：返回停掉的函数（测试用；平时随换账号、同步停了自己停）。
 * 没有本机库、outbox，或已经在换账号时什么都不做
 */
export function startSyncNotices(
  sync: Pick<Sync, 'onEvent' | 'subscribe' | 'getState'>, boot: BootResult, opts: SyncNoticeOptions = {},
): () => void {
  const { cache, outbox } = boot;
  if (!cache || !outbox || boot.switching) return () => undefined;

  const region = document.createElement('div');
  region.setAttribute('data-sync-notice', '');
  region.setAttribute('role', 'region');
  const live = document.createElement('div');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  const mount = document.createElement('div');
  region.append(live, mount);
  document.body.append(region);

  const store = createNoticeStore({
    outbox,
    readRow: async (table, id) => {
      const r = await cache.getRow(table, id);
      return (r?.view ?? r?.server ?? null) as Row | null;
    },
    resolveGone: opts.resolveGone ?? lazyResolveGone,
    log: opts.log,
    forkSuffix: forkSuffixOf(boot),
  });

  let root: Root | null = null;
  let stopped = false;
  const Host = opts.host ?? SyncNoticeHost;
  const onError = (err: unknown): void => {
    try {
      opts.log?.(JS_ERROR_ACT, { code: jsErrorCode(err, {}, location.origin) });
    } catch {
      // 日志出错不挡页面
    }
  };
  const mountHost = (): void => {
    if (root || stopped) return;
    const s = store.getState();
    if (s.queue.length === 0 && s.hardDeleted === 0) return;
    root = createRoot(mount);
    root.render(
      createElement(Boundary, { fallback: null, onError }, createElement(Suspense, { fallback: null }, createElement(Host, { store, live, region }))),
    );
  };

  const offs: (() => void)[] = [];
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    for (const off of offs.splice(0)) off();
    store.close();
    root?.unmount();
    root = null;
    region.remove();
  };
  /**
   * 换账号（含被移除、停用、冷静期的退出，都会先设 boot.switching）：停。
   * 不看同步引擎的 stopped（代码审查 K8 界面批 M1）：主页标签页隐藏时放锁、drain，引擎就是 stopped，回到前台又重新拿锁；
   * 跟着它卸掉的话这一页再也不出卡（iPhone 切到别的 app 就会触发）。限次暂停时卡留着也无妨，按钮只动本机库
   */
  const check = (): boolean => {
    if (boot.switching) stop();
    return stopped;
  };
  const onVisible = (): void => {
    try {
      if (document.visibilityState === 'visible' && !check()) void store.readGone();
    } catch (e) {
      onError(e);
    }
  };

  /** 订阅回调一律兜住：提示出错只记 js_error，不冒到 outbox 的写入、同步引擎的派发里（outbox.subscribe 在 enqueue 的 refresh 里同步调） */
  const safe = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A): void => {
    try {
      fn(...a);
    } catch (e) {
      onError(e);
    }
  };
  offs.push(
    store.subscribe(safe(mountHost)),
    sync.onEvent(safe((e) => {
      if (!check()) store.onSync(e);
    })),
    sync.subscribe(safe(() => void check())),
    outbox.onEvent(safe((e) => {
      if (!check()) store.onOutbox(e);
    })),
    outbox.subscribe(safe(() => {
      if (!check()) void store.readGone();
    })),
    () => document.removeEventListener('visibilitychange', onVisible),
  );
  document.addEventListener('visibilitychange', onVisible);
  void store.readGone();
  return stop;
}
