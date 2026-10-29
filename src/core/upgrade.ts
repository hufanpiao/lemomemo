// 强制升级与新版本（架构 0.27 第 1 点、8.1）：界面只读这里的状态，横幅和整屏提示由 UI 层（kit / app）画
// • 低于最低版本（启动、切到前台时用 config 比；收到 426 时用响应体里的 min）：挡同步、不挡查看和记录
//   → syncBlocked 不为 null：顶部固定一条关不掉的横幅“需要更新才能继续同步 · 你记下的内容都还在本机 · 更新”
// • 按“更新”：requestUpdate() → registration.update()，新 SW 接管后重新载入；没查成 → 'failed'（“更新失败 · 联网后再试”）；
//   查到了新 SW 但 30 秒内没接管 → 'stalled'（“新版本还没装好 · 请稍后再试”），不重新载入（BANNER-sugg ⑤：载入后仍是旧版本）；
//   重新载入后版本仍不够 → 'still_old'（“已是最新版本，请稍后再试”），不再自动重新载入，记错误码
// • 别的标签页以更高 DB_VERSION 打开本机库：本页关库、挡写入；没有录音和编辑在进行就自动重新载入，
//   否则 cache = 'closed_for_upgrade'（“柠檬记有新版本 · 重新打开”），录音或编辑结束（busy 归零）时自动重新载入
// • SW 在后台装好了新版本（8.1）：swReady = true，界面顶部提示“有新版本 · 重新打开”，不强制刷新；按了才 requestUpdate()
// • 本机库来自更新的版本（VersionError）：cache = 'too_new'，整屏提示“这台设备上的数据来自更新的版本，请更新柠檬记”
// • 升级本机库被挡住（blocked）：blocked = true，提示“请关掉其他打开的柠檬记窗口”
//   （boot.ts 收到 blocked 后等 BLOCKED_PROMPT_DELAY_MS 仍没打开才调 setBlocked(true)，配合升级的页关库期间不闪提示）
// • busy 兜底（PROBE-sugg2 ③、BANNER-sugg ⑥）：单个 busy 令牌超过 BUSY_MAX_MS（30 分钟）自动作废、记 upgrade_busy_expired，
//   免得哪里漏了释放，required、new_version、sync_paused 三种横幅一直不出、reloadPending 一直挂着。
//   作废后不自动重新载入（持有方可能真的还在录音、编辑）：等着的“更新”回到 idle，用户再按一次直接载入（不再去查）；closed_for_upgrade 的横幅本来就有“重新打开”
// 纯 TS：不准 import React 和任何功能（A1）
import { parseVersion, versionAtLeast } from '../../shared/core/version.ts';
import type { SwUpdateResult } from '../platform/sw-register.ts';

/** stalled：查到了新版本，但没能在 30 秒内装好、接管（BANNER-sugg ⑤） */
export type UpdatePhase = 'idle' | 'updating' | 'failed' | 'stalled' | 'still_old';

/** 单个 busy 令牌最多占多久（PROBE-sugg2 ③）：超过就作废、记日志 */
export const BUSY_MAX_MS = 30 * 60 * 1000;

/**
 * 占住 busy 的原因（作废时写进日志的 code 列）：只准是这几个固定的词，不准传带内容的文字（B 组审查建议 2）。
 * 现在只有退出登录用 sign_out；recording、editing 留给录音、编辑接上时用
 */
export type BusyReason = 'sign_out' | 'recording' | 'editing';

/** 升级中心的日志：同一个 act 每台设备每天（本机日期）最多几条（B 组审查建议 1，同 js_error 的 JS_ERROR_DAILY_MAX） */
export const UPGRADE_LOG_DAILY_MAX = 5;

export interface SyncBlock {
  /** 要求的最低版本；426 响应体里没有时为 null */
  min: string | null;
  /** '426'：刚收到 426；'config'：按缓存或刚刷新的 app_config 比出来的；'queue'：上次 426 暂停的队列还没解除（同一版本重启） */
  source: '426' | 'config' | 'queue';
}

export interface UpgradeState {
  /** 需要更新才能继续同步；null 表示不挡 */
  syncBlocked: SyncBlock | null;
  /** 本机库：ok / 被新版本的标签页要求关闭 / 来自更新的版本 */
  cache: 'ok' | 'closed_for_upgrade' | 'too_new';
  /** 升级本机库被别的标签页挡住 */
  blocked: boolean;
  /** “更新”按钮的进度 */
  update: UpdatePhase;
  /** 有录音、编辑在进行（横幅等它结束再出，0.27 第 1 点） */
  busy: boolean;
  /** SW 已在后台装好新版本、等着接管，或者别的标签页已让新 SW 接管了本页（8.1“有新版本 · 重新打开”） */
  swReady: boolean;
  /** 用户关掉了“有新版本”横幅（只在内存里）；和 swReady 分开记：关了横幅，新版本照样已就绪（复审建议 2） */
  swDismissed: boolean;
}

export interface UpgradeDeps {
  /** 本 App 的版本（platform/env.ts 的 buildInfo.version） */
  appVersion: string;
  /** 重新载入页面 */
  reload(): void;
  /** platform/sw-register.ts 的 updateServiceWorker */
  swUpdate(): Promise<SwUpdateResult>;
  /** 跨重新载入记住“刚按过更新”（platform/sw-register.ts 的 updateAttemptStore） */
  attempt: { get(): string | null; set(min: string | null): void };
  /** 记错误码（不记内容）：act 是动作名，code 可选（busy 作废时是 holdBusy 的 reason，例如 sign_out）；main.tsx 接到日志通道。
   *  同一个 act 每天最多 UPGRADE_LOG_DAILY_MAX 条（断网时连点“更新”不刷满本机 200 条队列和每天的日志额度） */
  log?(act: string, code?: string): void;
  /** 日志每日计数存哪里（platform/sw-register.ts 的 upgradeLogCountStore）；不给或读写出错时只在内存里计 */
  logCounts?: { get(): string | null; set(v: string): void };
  /** 墙上时钟（按本机日期分天）；默认 Date.now() */
  now?: () => number;
}

export interface UpgradeCenter {
  getState(): UpgradeState;
  /** useSyncExternalStore 用；状态不变时 getState() 返回同一个对象 */
  subscribe(listener: () => void): () => void;
  /** 收到 426：以响应体里的 min 为准（不用本机缓存的值） */
  reportUpgradeRequired(min: string | null, source?: '426' | 'queue'): void;
  /** 启动、切到前台时：按 app_config.min_client_version 比较（不会解除 426 带来的挡） */
  checkMinVersion(min: string | null | undefined): void;
  /** 本机库因为别的标签页升级而关了（cache.ts 的 onClosed('versionchange')） */
  onCacheVersionChange(): void;
  /** 本机库来自更新的版本（openCache 返回 version_too_new） */
  setCacheTooNew(): void;
  /** 升级本机库被别的标签页挡住 / 挡住解除 */
  setBlocked(blocked: boolean): void;
  /** SW 在后台装好了新版本（platform/sw-register.ts 的 watchServiceWorkerUpdate 回调） */
  setSwReady(): void;
  /** 关掉“有新版本”横幅（只记在内存里，下次打开 App 又会出；架构师 10-30 第 4 点）：只设 swDismissed，不动 swReady。426、本机库已关的横幅不给关 */
  dismissSwReady(): void;
  /**
   * 录音、编辑开始时调用，结束时调返回的函数。
   * 本机库已为升级关闭时，最后一个结束会自动重新载入：调用方在结束前自己把内存里的内容放好（库已关，写不进 drafts）
   */
  holdBusy(reason: BusyReason): () => void;
  /** 按“更新”：要重新载入时如果正在录音、编辑，等它结束再载入（复审建议 1） */
  requestUpdate(): Promise<UpdatePhase>;
  /** 启动时（checkMinVersion 和队列暂停都报过以后）调一次：刚按过更新而版本仍不够 → still_old */
  afterReloadCheck(): void;
}

/** 本机日期 YYYY-MM-DD（同 platform/env.ts 的 js_error 计数） */
function localDay(t: number): string {
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface LogCounts {
  d: string;
  c: Record<string, number>;
}

/** 按 act 每天限次的 log；计数优先读写 store，出错退回内存 */
function limitedLog(deps: UpgradeDeps): (act: string, code?: string) => void {
  const now = deps.now ?? (() => Date.now());
  let mem: LogCounts = { d: '', c: {} };
  let memOnly = false;
  const load = (day: string): LogCounts => {
    let st = mem;
    if (!memOnly && deps.logCounts) {
      try {
        const text = deps.logCounts.get();
        if (text) {
          const o = JSON.parse(text) as Partial<LogCounts> | null;
          if (o && typeof o.d === 'string' && typeof o.c === 'object' && o.c !== null) st = { d: o.d, c: { ...o.c } };
        }
      } catch {
        // 读不到或坏了：用内存里的
      }
    }
    return st.d === day ? st : { d: day, c: {} };
  };
  return (act, code) => {
    const log = deps.log;
    if (!log) return;
    try {
      const st = load(localDay(now()));
      const n = typeof st.c[act] === 'number' ? (st.c[act] as number) : 0;
      if (n >= UPGRADE_LOG_DAILY_MAX) return;
      st.c[act] = n + 1;
      mem = st;
      if (!memOnly && deps.logCounts) {
        try {
          deps.logCounts.set(JSON.stringify(st));
        } catch {
          memOnly = true;   // 写不进：这一页以后只用内存计数
        }
      }
      if (code === undefined) log(act);
      else log(act, code);
    } catch {
      // 日志出错不挡业务
    }
  };
}

function lowerThan(app: string, min: string): boolean {
  if (!parseVersion(app) || !parseVersion(min)) return false;
  return !versionAtLeast(app, min);
}

export function createUpgradeCenter(deps: UpgradeDeps): UpgradeCenter {
  const log = limitedLog(deps);
  let state: UpgradeState = { syncBlocked: null, cache: 'ok', blocked: false, update: 'idle', busy: false, swReady: false, swDismissed: false };
  const listeners = new Set<() => void>();
  const busy = new Map<number, BusyReason>();
  /** 每个令牌的兜底计时器 */
  const busyTimers = new Map<number, ReturnType<typeof setTimeout>>();
  let busySeq = 0;
  /** 按过“更新”、该重新载入了，但当时有录音、编辑在进行：等 busy 归零再载入 */
  let reloadPending = false;
  /** 等着的重新载入因 busy 作废被取消了：新 SW 已接管，下次按“更新”直接载入，不再去查（再查会因为没有 waiting 误报 still_old） */
  let reloadArmed = false;
  const reloadWhenIdle = (): void => {
    if (busy.size === 0) deps.reload();
    else reloadPending = true;
  };

  const set = (patch: Partial<UpgradeState>): void => {
    const next = { ...state, ...patch };
    const changed = (Object.keys(patch) as (keyof UpgradeState)[]).some((k) => JSON.stringify(next[k]) !== JSON.stringify(state[k]));
    if (!changed) return;
    state = next;
    for (const l of [...listeners]) l();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reportUpgradeRequired(min, source = '426') {
      // 426 一律挡：服务器说了算（min 拿不到也挡）
      const cur = state.syncBlocked;
      if (cur && cur.source === '426' && source === 'queue') return;
      set({ syncBlocked: { min, source } });
    },
    checkMinVersion(min) {
      const cur = state.syncBlocked;
      if (min && lowerThan(deps.appVersion, min)) {
        if (!cur || cur.source === 'config') set({ syncBlocked: { min, source: 'config' } });
        return;
      }
      if (cur?.source === 'config') set({ syncBlocked: null });
    },
    onCacheVersionChange() {
      set({ cache: 'closed_for_upgrade' });
      if (busy.size === 0) deps.reload();
    },
    setCacheTooNew() {
      set({ cache: 'too_new' });
    },
    setBlocked(blocked) {
      set({ blocked });
    },
    setSwReady() {
      set({ swReady: true });
    },
    dismissSwReady() {
      set({ swDismissed: true });
    },
    holdBusy(reason) {
      const key = ++busySeq;
      busy.set(key, reason);
      set({ busy: true });
      let released = false;
      const drop = (): boolean => {
        if (released) return false;
        released = true;
        clearTimeout(busyTimers.get(key));
        busyTimers.delete(key);
        busy.delete(key);
        return busy.size === 0;
      };
      // 兜底：超过 BUSY_MAX_MS 还没释放就作废这一个令牌（不自动重新载入，见文件头）
      busyTimers.set(key, setTimeout(() => {
        const idle = drop();
        log('upgrade_busy_expired', reason);
        if (!idle) return;
        if (reloadPending) {
          reloadPending = false;
          reloadArmed = true;
          if (state.update === 'updating') set({ update: 'idle' });
        }
        set({ busy: false });
      }, BUSY_MAX_MS));
      return () => {
        if (!drop()) return;
        set({ busy: false });
        if (state.cache === 'closed_for_upgrade' || reloadPending) {
          reloadPending = false;
          deps.reload();
        }
      };
    },
    async requestUpdate() {
      if (state.update === 'updating') return 'updating';
      set({ update: 'updating' });
      if (reloadArmed) {
        reloadArmed = false;
        reloadWhenIdle();
        return 'updating';
      }
      deps.attempt.set(state.syncBlocked?.min ?? '');
      const r = await deps.swUpdate();
      if (r === 'reloading') {
        reloadWhenIdle();
        return 'updating';
      }
      // 别的标签页已经按过、新 SW 已接管（这一页 reg.waiting 没了，update() 查不到新的，断网时还会失败）：swReady 说明新版本已经装好，
      // 直接重新载入就是新版本；不能当成“没有新版本”挂着不动、更不能误报“已是最新版本”或“更新失败”（审查必改 2、复审必改）。
      // 横幅关没关（swDismissed）不影响这一条。只认“没查成”（failed）和“查成了没有 waiting”（no_update）：
      // 接管超时（takeover_timeout）不在这里，载入后还是旧版本（BANNER-sugg ⑤）
      if ((r === 'no_update' || r === 'failed') && state.swReady) {
        reloadWhenIdle();
        return 'updating';
      }
      deps.attempt.set(null);
      // 查到了新版本但没接管（BANNER-sugg ⑤）：不重新载入，swReady 也不算（载入后仍是旧版本，426 时还会误报“已是最新版本”）
      if (r === 'takeover_timeout') {
        log('update_takeover_timeout');
        set({ update: 'stalled' });
        return 'stalled';
      }
      // 本机库来自更新的版本（too_new）时，没有新版本也要告诉用户（整屏提示上点了没反应不行）
      if (r === 'no_update' && (state.syncBlocked || state.cache === 'too_new')) {
        log('update_still_old');
        set({ update: 'still_old' });
        return 'still_old';
      }
      if (r === 'no_update') {
        set({ update: 'idle' });
        return 'idle';
      }
      log(r === 'unsupported' ? 'update_unsupported' : 'update_failed');
      set({ update: 'failed' });
      return 'failed';
    },
    afterReloadCheck() {
      const attempted = deps.attempt.get();
      if (attempted === null) return;
      deps.attempt.set(null);
      if (state.syncBlocked || state.cache === 'too_new') {
        log('update_still_old');
        set({ update: 'still_old' });
      }
    },
  };
}
