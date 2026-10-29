// 顶部的版本横幅（架构 0.27 第 1 点、8.1、4.1 onversionchange；TC-B1-42、43、48 的界面部分）。三种，按这个先后只出一条：
// 1. 需要更新（低于最低版本、收到 426、上次 426 暂停的队列没解除）：固定一条关不掉的横幅
//    “需要更新才能继续同步 · 你记下的内容都还在本机 · 更新”；队列里有没发的，再加一行“有 N 条等更新后同步 · 内容还在本机”。
//    挡同步不挡查看和记录：横幅不盖页面、不抢焦点；录音、编辑在进行（upgrade.busy）时先不出，结束后再出
// 2. 本机库被新版本的标签页要求关闭（closed_for_upgrade）：“柠檬记有新版本 · 重新打开”，按钮直接重新载入。
//    这时正在编辑才会走到这里（空闲时升级中心已自动重新载入），所以不等 busy
// 3. SW 在后台装好了新版本（swReady）：“有新版本 · 重新打开”，不强制刷新；录音、编辑在进行时先不出；
//    这一种能关（只记在内存里，下次打开 App 又会出；架构师 10-30 第 4 点），前两种不给关
// （排在 2 和 3 之间）同步暂停（sync_paused）：主 App 收到 account_disabled、探测说账号正常，但 5 分钟内已重新载入过一次
//    （app/sync-disabled.ts 限次，复审建议 10-30）：“同步暂停，请稍后重新打开 · 重新打开”，不给关；录音、编辑在进行时先不出；
//    状态在 kit/state/ui-store 的 banners
// 横幅出现时在根节点（<html>）设 data-top-banner：横幅占顶部安全区，页面的 var(--safe-top) 变成 0（base.css，10-30 第 7 点）
// “更新”“重新打开（新版本）”都走 upgrade.requestUpdate()（拉新 SW、接管后重新载入）；进度、失败、仍不够新用 role="status" 播报。
// 只画在 App 里、和页面同一个 Suspense 里（App.tsx）：告知页关口、启动画面期间不出，页面分包到了才和页面一起画；
// 在页面的错误边界外面（10-30 第 6 点）：页面出错时横幅还在。
// 按钮用普通 <button>，不用 motion 的 Pressable：横幅静态进首屏，motion 的汇总出口会把动效库一起拉进首屏（审查必改 1，首屏预算 W3）
import { useLayoutEffect, useSyncExternalStore } from 'react';
import type { Outbox, OutboxStatus } from '../core/outbox-types.ts';
import type { UpgradeCenter, UpgradeState } from '../core/upgrade.ts';
import { useT } from '../kit/hooks/useT.ts';
import { useUi } from '../kit/state/ui-store.ts';
import styles from './UpdateBanner.module.css';

export interface UpdateBannerProps {
  /** boot.upgrade */
  upgrade: UpgradeCenter;
  /** boot.outbox（数“有 N 条等更新后同步”）；本机库打不开时为 null */
  outbox: Outbox | null;
  /** “重新打开”（本机库已关时）：重新载入页面 */
  onReload(): void;
}

export type BannerKind = 'required' | 'closed' | 'sync_paused' | 'new_version' | null;

/** 现在该出哪一条（纯函数，单测用）；syncPaused：ui-store 里有 sync-paused 横幅 */
export function bannerKind(s: UpgradeState, syncPaused = false): BannerKind {
  if (s.cache === 'too_new') return null;   // 整屏提示管
  if (s.syncBlocked) return s.busy ? null : 'required';
  if (s.cache === 'closed_for_upgrade') return 'closed';
  // 录音、编辑在进行时先不出（同 new_version；第六轮审查建议 ④），busy 归零后状态一变就出
  if (syncPaused) return s.busy ? null : 'sync_paused';
  if (s.swReady && !s.swDismissed) return s.busy ? null : 'new_version';
  return null;
}

const EMPTY_STATUS: OutboxStatus = { pending: 0, failed: 0, paused: null, remindRecs: new Set() };
const noSubscribe = (): (() => void) => () => undefined;

export function UpdateBanner({ upgrade, outbox, onReload }: UpdateBannerProps) {
  const t = useT();
  const state = useSyncExternalStore(upgrade.subscribe, upgrade.getState);
  const queue = useSyncExternalStore(outbox ? outbox.subscribe : noSubscribe, outbox ? outbox.getStatus : () => EMPTY_STATUS);
  const syncPaused = useUi((s) => s.banners.some((b) => b.kind === 'sync-paused'));
  const kind = bannerKind(state, syncPaused);
  useLayoutEffect(() => {
    if (!kind) return undefined;
    const root = document.documentElement;
    root.dataset['topBanner'] = kind;
    return () => {
      delete root.dataset['topBanner'];
    };
  }, [kind]);
  if (!kind) return null;

  const updating = state.update === 'updating';
  const progress =
    state.update === 'updating'
      ? t('update.updating', {})
      : state.update === 'failed'
        ? t('update.failed', {})
        : state.update === 'stalled'
          ? t('update.stalled', {})
          : state.update === 'still_old'
            ? t('update.stillOld', {})
            : '';
  const update = (): void => {
    if (!updating) void upgrade.requestUpdate();
  };

  const text =
    kind === 'required'
      ? t('update.required', {})
      : kind === 'closed'
        ? t('update.available', {})
        : kind === 'sync_paused'
          ? t('update.syncPaused', {})
          : t('update.newVersion', {});
  /** 只重新载入、不拉新版本的两种 */
  const reloadOnly = kind === 'closed' || kind === 'sync_paused';
  const button = kind === 'required' ? t('update.update', {}) : t('update.reopen', {});
  return (
    <div className={styles.banner} data-testid="update-banner" data-kind={kind}>
      <div className={styles.text}>
        <p className={styles.main}>{text}</p>
        {kind === 'required' && queue.pending > 0 ? <p className={styles.sub}>{t('update.queued', { n: queue.pending })}</p> : null}
        <p role="status" className={styles.sub}>
          {reloadOnly ? '' : progress}
        </p>
      </div>
      <button type="button" className={styles.action} aria-disabled={!reloadOnly && updating} onClick={reloadOnly ? onReload : update}>
        {button}
      </button>
      {kind === 'new_version' ? (
        <button type="button" className={styles.close} aria-label={t('common.close', {})} onClick={() => upgrade.dismissSwReady()}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
