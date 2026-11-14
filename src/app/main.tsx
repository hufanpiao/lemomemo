// 入口（架构 2.2、4.1）：装 exe 桥 → 读本机会话（没登录删库去登录页）→ coldStart → 定界面语言 → 挂功能入口 → 挂换账号监听 → 过告知页关口渲染 → 启动同步
// 不变量：换账号、会话没了的监听在 render 之前挂、挂上马上再比一次；会话没了交 core/device-exit.ts 的 exitOnSessionLoss
// 不变量：告知页关口读失败、超时、懒加载失败都不挡进 App；启动画面最多盖 5 秒、#root 第一次画出东西（root-paint.ts 的 whenContent）的下一帧收起，进退出屏时直接收；StrictMode 只在开发版开
// 每一步的理由见 docs/10-架构/历史版本/文件头原文-2026-11-11退出链路整改.md
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/tokens.css';
import '../styles/skins/simple.css';
import '../styles/skins/glass.css';
import '../styles/base.css';
import { fromUiLocale, LOCALE_STORAGE_KEY, pickLocale, toUiLocale } from '../../shared/i18n/pick-locale.ts';
import { watchAccount, wipeLocal } from '../core/account.ts';
import { defaultExitDeps, exitOnSessionLoss, REAUTH_GRACE_MS, type ExitDeps } from '../core/device-exit.ts';
import { hasAuthLoss, readReauth } from '../platform/auth-loss-store.ts';
import { coldStart, type BootResult } from '../core/boot.ts';
import { deleteCacheDb } from '../core/cache.ts';
import { collection } from '../core/store.ts';
import { waitLook } from './look-wait.ts';
import type { LookRow } from '../platform/look.ts';
import { createLogQueue, guardOwner } from '../core/log/queue.ts';
import { logEvent, setLogSink } from '../../shared/core/log-bus.ts';
import { devicePlatform, readInstallId, withLock } from '../platform/device-info.ts';
import { clearOtherLogQueues, logQueueStore } from '../platform/log-store.ts';
import { expectPushClaimContext, runPushClaim, setPushClaimContext } from '../platform/push-claim-run.ts';
import { setPushDisconnectLog } from '../platform/push-disconnect.ts';
import { browserLifecycle } from '../platform/net.ts';
import { uiStore } from '../kit/state/ui-store.ts';
import { buildInfo, isTauri, registerJsErrorLog } from '../platform/env.ts';
import { gapFixWanted, startEarlyGapFix } from '../platform/vh-gapfix-gate.ts';
import {
  clearCacheStorage, clearLocalSessionIf, goToAuth, onAuthUser, onSessionStorageChange, readSessionAccessToken, readSessionId, readSessionUserId,
  markAccountUiShown, setExitNotice, takeLocalSession,
} from '../platform/session.ts';
import { settleDropAtStartup } from '../platform/session-drop.ts';
import { enableDropMark, installDesktopSession } from '../platform/session-store.ts';
import { hideSplash, hideSplashAfter } from '../platform/splash.ts';
import { afterAppPainted, appPainted, startAppPaintLimit, watchRoot, whenContent } from '../platform/root-paint.ts';
import { markInsetPainted, watchInsetBottom } from '../platform/inset-watch.ts';
import { loadMotionFeatures, nextFrame } from '../motion/index.ts';
import { registerSw, reloadPage, upgradeLogCountStore } from '../platform/sw-register.ts';
import { mountExitScreen, watchExitIncomplete } from './exit-screen.tsx';
import { mountFeatures } from './features.ts';
import { goHref } from './router.ts';
import { logQueueCleaner, outboxLog, toLogRecord } from './log-channel.ts';
import { GATE_LIMIT_MS, startRoot, watchCacheBlocked, withCrashFallback } from './root.tsx';
import { AFTER_PAINT_NOTICE_AT, lazyLogUploader, loadAfterPaint, startAfterPaint, type AfterPaint } from './after-paint.ts';
import { applyDocLocale } from '../platform/doc-locale.ts';

/** 界面语言（16.4）：缓存的 profiles.ui_locale → 本机选过的（pv-locale）→ 设备语言 → 中文；规则同 src/auth/main.tsx，多一层缓存的 profile */
function applyLocale(boot: Pick<BootResult, 'profile'>): void {
  const cachedUi = boot.profile?.['ui_locale'];
  let savedLocal: string | null = null;
  try {
    savedLocal = localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    savedLocal = null;
  }
  const uiLocale = toUiLocale(pickLocale(fromUiLocale(typeof cachedUi === 'string' ? cachedUi : null) ?? savedLocal, navigator.languages));
  uiStore.getState().setLocale(uiLocale);
  applyDocLocale(uiLocale);
}

// 诊断启动件（运行日志，platform/diag-boot.ts）：只在非正式版动态下载，正式构建靠 MODE 常量整块摇掉；启动画面收起不等它
if (import.meta.env.MODE !== 'production') void import('../platform/diag-boot.ts').then((m) => m.startDiagBoot()).catch(() => undefined);
// 启动画面最晚 5 秒收起：从入口模块开始执行算起（关口、冷启动、分包加载哪一步卡住都不再盖着）
hideSplashAfter(hideSplash);
// 皮肤、深浅色（ADR-008）：入口一开始就懒加载 platform/look.ts（不进首屏），它一加载就按本机缓存套到 <html> 上，再盯住 settings 集合（coldStart 灌好、同步回来都重新套）；
// 渲染之前最多等它 600 毫秒（下面 createRoot 前，app/look-wait.ts），首屏不先闪一下默认皮肤；超时、加载失败按入口页写的默认皮肤照样渲染。
// 皮肤、深浅色变化记 look_apply，字体记 font_load（日志总线接上以前的先在内存留着）
const look = import('../platform/look.ts').then((m) => m.watchLook(collection<LookRow & { id: string }>('settings'), logEvent), () => undefined);
// 底部安全区（G10）：iOS 主屏幕版冷启动时先 0 后 34，稳定前底栏、“＋”、实色带不显示，稳定了淡入；首屏画完后最多藏 1.5 秒（platform/inset-watch.ts）
watchInsetBottom();
// R-371 Gap fix（底栏偏高修复，11-11 起默认开、正式版也做）：只在 iOS 主屏幕版冷启动时下载 platform/vh-gapfix.ts 做一次（判断见 vh-gapfix-gate.ts，
// 诊断页可以关掉对照）；等帧传 motion 的 nextFrame（A25）
// 台账 Q-2：先在这里同步早试一次（启动画面还盖着，不等下载、不等底栏），不成再由 vh-gapfix.ts 等底栏挂上后照原样补一次
if (gapFixWanted()) {
  startEarlyGapFix(nextFrame);
  void import('../platform/vh-gapfix.ts').then((m) => m.startGapFix(nextFrame));
}

/** exe（Tauri）里换上 exe 的 platform 桥（架构 0.53 第 2 条）：openReminder、openAuth、本机通知改走 exe；网页版不加载 desktop.ts */
async function installNativeBridge(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { installDesktopBridge } = await import('../platform/desktop.ts');
    installDesktopBridge(goHref); // 点 exe 通知打开整页提醒走路由压带编号的历史（R-372 代码审 M1）
  } catch {
    // 分包加载失败：留着网页版的桥（照常能用，只是 exe 专有的几件退回网页做法）
  }
}

/** 启动件连续下载失败时那条横幅的 id（kind 用 sync-paused；和同步引擎的 sync-paused 分开，下载成功只收掉这一条） */
const AFTER_PAINT_BANNER_ID = 'after-paint-failed';

async function start(): Promise<void> {
  // 最先装桥：下面没登录时的 goToAuth（openAuth）、渲染、boot 都要用 exe 的那一份
  await installNativeBridge();
  // exe：会话改存凭据管理器（F5-2 / N1）。在第一次读会话、建 supabase 客户端之前 preload 好；
  // 登录小窗口写好会话后（auth:done）整页重新载入，不在原来的界面树上刷新（FA2-3）。网页版什么也不做
  const installed = await installDesktopSession(reloadPage);
  if (isTauri() && !installed) {
    // 读不到凭据管理器（代码审查建议 4）：不往下走（登录了也接不上），提示重新打开
    void hideSplash();
    mountExitScreen('unavailable');
    return;
  }
  // 上次退出时会话没删掉（A-1 的“待删除”标记）：先删；删不掉不画账号界面，只给“退出没完成，点重试”
  // 只有主窗口记“待删除”标记（登录小窗口不记，安全复审建议 ①）
  enableDropMark();
  if (!(await settleDropAtStartup())) {
    void hideSplash();
    mountExitScreen('incomplete');
    return;
  }
  const el = document.getElementById('root');
  if (!el) throw new Error('root_missing');
  // #root 画没画出东西只看 root-paint.ts：这里挂上，并开始算首屏画完（第一个页面出来再过一帧；同步、设备登记、SW 注册都排在它后面，
  // supabase-js 不和页面分包抢下载，B2 FA-6 ①）。这里只有 15 秒长兜底，正式的时限在 render 之后才开始算（见下面 startAppPaintLimit）
  watchRoot(el, nextFrame);
  // 告知页关口还在问服务器时 #root 是空的，启动画面继续盖着；一画出东西就在下一帧收起
  whenContent(() => void nextFrame(() => void hideSplash()));
  // 底部安全区“稳定”从首屏画完起算（G10，底栏跟着第一个页面出来）
  afterAppPainted(markInsetPainted);
  el.dataset['version'] = buildInfo.version;

  const userId = readSessionUserId();
  if (!userId) {
    // 没登录：库还在就按库名整库删掉（coldStart 的 signed_out 分支），未同步的修改一起丢（R-231）。
    // 不等删库，直接去登录页（登录页审查建议 2）：coldStart 在第一个 await 之前就同步发出了 deleteDatabase，跳转不影响它执行
    // 例外（R-382 架构 4.1a 第 2 点）：有 lemo.reauth 且没过期是登录过期，coldStart 不删库，日志队列也留着（同一账号重新登录后照传），
    // 登录页提示“登录已过期，请重新登录”
    const kept = readReauth() !== null;
    // 日志上传队列、外观、隐私记同意也由 coldStart 一起清（同一个同步段里，在第一个 await 之前）
    void coldStart({ userId: null }).catch(() => undefined);
    if (kept) goToAuth('expired', null);
    else goToAuth();
    return;
  }

  // 业务日志都进日志总线（shared/core/log-bus.ts）：outbox、同步、时区上报、设备登记、提醒、QuietBoundary 各自 logEvent，下面 setLogSink 接一次上传队列。
  // 退出、换账号时断开推送下载失败、断开抛错（platform/push-disconnect.ts）：记一条，code 是 load / timeout / error / fallback，不挡退出
  setPushDisconnectLog((code) => logEvent('push_disconnect_fail', { code }));
  // 客户端错误日志（TC-B1-68、架构 6.1）：只记“类型@文件名:行号”，同一个 code 每天 5 条
  registerJsErrorLog(logEvent);
  // 写 logs 表的那一端（架构 0.38 第 68 条）：localStorage 队列 lemo.logq.<user_id>，主页在线时批量上传；别的账号留下的队列清掉
  clearOtherLogQueues(userId);
  // 上传前核对会话主人：别的标签页换成了别的账号，这一页拿到的是新账号的令牌，不能用它传这个账号的日志
  // 上传那一端第一次真上传时才加载（after-paint.ts 的 lazyLogUploader，FA-6 ③：sync-net 不在首屏）；加载失败这一批回 retry
  const logQueue = createLogQueue({
    store: logQueueStore(userId), upload: guardOwner(userId, readSessionUserId, lazyLogUploader()),
    isOnline: () => browserLifecycle.isOnline(), onOnline: (fn) => browserLifecycle.onOnline(fn),
  });
  setLogSink((act, f) => logQueue.add(toLogRecord(act, f, Date.now())));
  // 上次会话丢失的原因码（R-382 架构 4.1a 第 3 点）：只把 uid_h 对得上本账号的几条按 auth_loss 上传，别的账号的直接丢；取完整个键删掉
  // 本机有这个键才动态引入（auth-loss-log.ts 带 crypto.subtle 哈希，不进首屏；平时没有这个键，不下载）
  if (hasAuthLoss()) void import('../platform/auth-loss-log.ts')
    .then(async (m) => (await m.takeAuthLossFor(userId, readInstallId())).forEach((e) => logEvent('auth_loss', { code: m.authLossLogCode(e) })))
    .catch(() => undefined);
  // 被移除、停用、注销冷静期、本页收到 SIGNED_OUT：停止上传并清掉这个账号的日志队列（架构 0.38 第 68 条）；
  // 交给 lossExit（core/device-exit.ts 的 exitOnSessionLoss）和 wireSync 共用
  const clearLogs = logQueueCleaner(logQueue, userId);
  /** 已按 boot 的 profile 定过界面语言（之后 blocked 也不再按“没有 profile”覆盖） */
  let localeFromBoot = false;
  const boot = await coldStart({
    userId,
    outboxOptions: { log: outboxLog(logEvent) },
    // 别的标签页退出登录、按库名删本机库（versionchange 的 newVersion 为 null，K6 复审 C）：同步读一次会话，
    // 没有了就回登录页（库正在被删，watchAccount 收到 storage 事件后也会走退出流程，重复跳转无害）；还有（那边已重新登录）就重新载入
    onCacheDeleted: () => (readSessionUserId() ? reloadPage() : goToAuth()),
    // 升级中心的错误码（update_failed、update_takeover_timeout、upgrade_busy_expired 等，PROBE-sugg2 ③）进同一条日志总线（logEvent）；
    // 同一个 act 每天最多 5 条，计数在 localStorage lemo.upglog（B 组审查建议 1）
    upgradeDeps: { log: (act, code) => logEvent(act, code ? { code } : undefined), logCounts: upgradeLogCountStore },
    // 升级本机库被别的标签页挡住：coldStart 还在等库打开时整屏提示（文案见 update.blocked.title），库打开后自动消失（root.tsx，架构师 10-30 第 8 点）。
    // 这时 profile 还没读出来：blocked 第一次为 true、整屏提示画出来之前才按本机选过的语言和设备语言定一次界面语言（BANNER-sugg ③；
    // 没被挡住就不定，下面 applyLocale(boot) 按缓存的 profile 定；已经按 profile 定过就不再覆盖）
    onUpgradeCenter: (u) => {
      watchCacheBlocked(u, { onFirstBlocked: () => (localeFromBoot ? undefined : applyLocale({ profile: null })) });
    },
  });
  applyLocale(boot);
  localeFromBoot = true;
  // unavailable 照样渲染 App（只联网用）；version_too_new 只渲染整屏提示（下面），不挂功能入口
  mountFeatures(boot.flags);

  // 换账号监听在 render 之前挂（K6 复审 N4）：挂上时同步再比一次会话，coldStart 期间已经换了账号或退出就不渲染，直接走换账号流程
  // 会话没了（本页 SIGNED_OUT、别的标签页退出）走退出出口 core/device-exit.ts：清库时关掉连接后按库名删库（不留库文件，登录页审查）；
  // 这两路原来就不广播 reset（别的标签页各自收得到 storage 事件）
  const lossExit: ExitDeps = {
    ...defaultExitDeps,
    getBoot: () => boot,
    wipe: (b) => wipeLocal(b, { clearCacheStorage, deleteDb: () => deleteCacheDb(), dropDb: true, log: logEvent }),
    clearLogs,
    broadcastReset: () => undefined,
    log: logEvent,
  };
  watchAccount(boot, {
    clearCacheStorage,
    onAuthUser,
    onStorageUser: (fn) => onSessionStorageChange(fn),
    currentUserId: () => readSessionUserId(),
    // 本页收到 SIGNED_OUT：判断会话归谁的同一刻就删本机会话，回登录页前只在会话还是那一个时再删（K6-signedout-sugg2 ①）
    dropSession: () => takeLocalSession(),
    // R-382：别的标签页删了会话，等它写好 lemo.reauth 再判断是登录过期还是退出了
    onSessionLost: (loss) => exitOnSessionLoss(loss, lossExit, REAUTH_GRACE_MS),
    // 清库失败（onFailed 不填）同样重新载入：冷启动会在读写任何东西之前再清一次，再失败就降级成 unavailable、不渲染缓存
    // 不删本机会话：会话是各标签页共用的，删了会把别的标签页刚登录的新账号也登出
    onSwitched: reloadPage,
  });
  if (boot.switching) return;
  // 推送认领的上下文要等首屏画完才设（下面 setPushClaimContext）：这之前设置 › 提醒 的点按认领先等它，不当场回 claim_failed（推迟启动审查 L3）
  expectPushClaimContext();

  // 选根（root.tsx）：在线先过告知页关口；本机库来自更新的版本（TC-B1-49，K6-ver-new）只渲染整屏提示（先注册 SW 再渲染，复审 S4；只注册，不盯新版本）
  const root = await startRoot(boot, {
    online: browserLifecycle.isOnline(),
    onRefresh: reloadPage,
    ...(import.meta.env.DEV ? {} : { registerSw }),
  });
  // 最外层兜底（K6-sugg3 ⑥）：App 顶层出错不白屏，显示静态的“出错了 · 刷新”
  const guarded = withCrashFallback(root, reloadPage);
  await waitLook(look);
  createRoot(el).render(import.meta.env.DEV ? <StrictMode>{guarded}</StrictMode> : guarded);
  // 首屏时限从 render 起算（FA-6 推迟启动审查 L1）：告知页关口最多空白 GATE_LIMIT_MS（5 秒）后一定会画出页面，
  // 时限取它再加 1 秒，关口慢时同步也不会在关口还空白时先起、和告知页分包抢下载；一直不画功能页的整屏提示、
  // 后台标签页（rAF 不跑）最多多等这么久
  startAppPaintLimit(GATE_LIMIT_MS + 1000);
  // 账号的界面画出来了：exe 里之后退出、被移除时先整页重新载入，再开登录小窗口（FA2-3）
  markAccountUiShown();
  // exe：之后退出、被移除时删会话失败，盖上“退出没完成，点重试”（A-1）；网页版不会出现
  if (isTauri()) watchExitIncomplete();

  // 等第一个页面画出来（B2 FA-6 ①）：同步引擎一启动就要 supabase-js（realtime 订阅、刷新令牌、读 config），
  // 原来紧跟在 render 后面，今天页分包还没到就先下载了 supabase-js。换账号、退出的监听（watchAccount）已在 render 之前挂好，不受影响。
  // 取舍（审查 L4）：会话被撤销、账号停用要等同步引擎或 supabase-js 起来才发现，最多推后这一段（通常几百毫秒）；本机缓存的内容本来就先画
  await appPainted();
  // 等的这段时间里可能已经在换账号、退出（watchAccount 设了闸、封了库、退订了推送）：后面的同步、设备登记、推送认领、SW 注册
  // 用的都是这个账号（userId）、本机库和当前会话的令牌，一律不再做（FA-6 推迟启动审查 M1）。等着上下文的点按认领立刻回 claim_failed（L3）。
  // 同步再比一次本机会话（安全复审 L6）：别的标签页已经换了账号、watchAccount 还没来得及设闸时，同样不用旧账号做下面这些。
  // 下面下载启动件前后的闸也是这一个 stillOwner
  const stillOwner = (): boolean => !boot.switching && readSessionUserId() === userId;
  if (!stillOwner()) {
    setPushClaimContext(null);
    return;
  }
  // SW 注册不依赖下面那批代码（③ 审查 M1）：过了第一道闸就注册，下载失败、重试期间照样有 SW 缓存和新版本提示。version_too_new 时上面已经注册过
  // 注册以后盯住“后台装好了新版本”（8.1）：顶部提示“有新版本 · 重新打开”（App.tsx 的 UpdateBanner），不强制刷新；回到前台查新版本。
  // 注册的代码这时才下载（platform/sw-lifecycle.ts）；下载、注册都不设超时（安全审 M1、Q-23），下面的推送认领照常等到 reg；失败才是 null
  const swReg: Promise<ServiceWorkerRegistration | null> =
    !import.meta.env.DEV && boot.status !== 'version_too_new'
      ? // 万一里面抛错（下载、注册、挂监听都已各自接住，这里再兜一层）：按“没注册”处理，不留没处理的拒绝、不影响首屏
        registerSw({ onReady: () => boot.upgrade.setSwReady(), life: browserLifecycle }).catch(() => null)
      : Promise.resolve(null);

  /** 下载到了、闸也过了（startAfterPaint 保证）：起同步、设备登记、推送认领。这里面全是同步调用，查完闸到用上账号之间没有空档 */
  const startSync = (late: AfterPaint): void => {
    const { createSupabaseTransport, createDeviceRegistrar, wireSync, probeAccountForExit } = late;

    // 同步（K8）：只在 boot 正常时启动；被移除（同步引擎、outbox 的 removed 事件）只处理一次：清空本机、删本机会话、回登录页
    // 设备行（0.38 第 62 条④，接手清单 K8-tz-device）：主页拿到锁后登记或复用本会话的 devices 行，id 存 meta，report_tz 用它
    const transport = createSupabaseTransport();
    const platform = devicePlatform();
    const device = boot.cache
      ? createDeviceRegistrar({
          transport, cache: boot.cache, platform, appVersion: buildInfo.version,
          sessionId: () => readSessionId(), installId: () => readInstallId(),
          lock: (fn) => withLock(`lemo-device-reg:${userId}`, fn), log: logEvent,
        })
      : null;
    wireSync(boot, {
      transport, clearCacheStorage, goToAuth, platform, log: logEvent,
      // 第二个参数是 sid（被拒那次请求的会话），不是 session 的 setExitNotice 的 storage，要包一层
      setExitNotice: (n, sid) => setExitNotice(n, undefined, { sid: sid ?? null }),
      // 被移除、停用：一收到就删被拒那次请求的会话，回登录页前只在会话还是那一个时再删（K6-sugg3 ①；sid 必填，K6-sugg5 ②）
      clearLocalSessionIf: (sid) => clearLocalSessionIf(sid),
      // 收到 account_disabled 先探测是停用还是注销冷静期（R-256 ③ 后续）：用被拒那次会话的令牌调 account status
      probeAccount: (token) => probeAccountForExit({ token }),
      readSession: () => ({ sid: readSessionId(), token: readSessionAccessToken() }),
      readUserId: () => readSessionUserId(),
      reload: reloadPage,
      // 限次触发、已让出同步主页：顶部出“同步暂停，请稍后重新打开”（App.tsx 的 UpdateBanner 读 ui-store 的 sync-paused）
      onSyncPaused: () => uiStore.getState().pushBanner({ id: 'sync-paused', kind: 'sync-paused' }),
      onLeader: (on) => logQueue.setLeader(on),
      clearLogs,
      ...(device ? { deviceId: device.id, ensureDevice: device.ensure } : {}),
    });

    // 推送认领的参数（账号锁、设备登记）由 platform/push-claim-run.ts 统一拼，启动认领和设置 › 提醒 的点按认领用同一份（FA-4 代码审查中 2）
    setPushClaimContext({
      userId, platform, claim: (a) => transport.claimEndpoint(a), sessionId: () => readSessionId(), currentUserId: () => readSessionUserId(),
      ...(device ? { ensureDevice: device.ensure, invalidateDevice: device.invalidate } : {}),
    });

    // 推送订阅（FA-1；换账号时旧订阅已退订，FE-2）：SW 注册好了才认领；通知权限已给就重订、认领到这个账号；没给不弹权限框（只在设置 › 提醒的点按里请求）
    // 先等本会话的设备行登记好再认领（代码审查 M3、安全审查 S1）；记录按“账号 + 会话 + endpoint”的摘要（FA2-1、FA2-2）；几个标签页串着来（S2）
    // 结果写进 push-status 交给设置 › 提醒（被占着出“移除它”、要重新打开、不支持）
    void swReg.then((reg) => {
      if (reg) void runPushClaim();
    });
  };

  // 同步、设备登记、账号状态探测的代码这时才下载（after-paint.ts，FA-6 ③：zod、supabase 封装移出首屏）。
  // 下载失败、超时（离线又没有 SW 缓存、网络卡住）：退避重试，恢复网络、切回前台立刻再试；每次下载前、回来后都过同一道换账号闸（③ 审查 M1）。
  // 第一次失败就设 null 推送认领上下文（点按认领当场回 claim_failed，不多等），下载成功后再设；本机缓存照常能看、能改（outbox 留着）。
  // 连续失败 AFTER_PAINT_NOTICE_AT 次：顶部出“同步暂停 · 重新打开”（沿用 sync-paused 横幅和文案，主持人 11-04 定；重新打开也绕开浏览器缓存失败的动态 import，L2）
  startAfterPaint({
    load: loadAfterPaint,
    stillOwner,
    onAbandoned: () => setPushClaimContext(null),
    life: browserLifecycle,
    onFailed: (n, why) => {
      if (n === 1) setPushClaimContext(null);
      if (n === 1 || n === AFTER_PAINT_NOTICE_AT) logEvent('after_paint_load_failed', { code: `${why}:${n}` });
      if (n === AFTER_PAINT_NOTICE_AT) uiStore.getState().pushBanner({ id: AFTER_PAINT_BANNER_ID, kind: 'sync-paused' });
    },
    onLoaded: (late) => {
      uiStore.getState().dismissBanner(AFTER_PAINT_BANNER_ID);
      startSync(late);
    },
  });
  // 动画实现和功能包（R-354，主持人 11-07 定）：首屏画完以后立刻下载，排在首屏后那批代码后面（方案 K8）；
  // 到了以后门面在安全的时机换成动画实现（src/motion/features.ts）。失败不抛，门面照常显示、只是没有动画
  void loadMotionFeatures();
}

// start 自己不该抛（coldStart 不抛）；万一抛了（例如没有 #root）不留白屏：回登录页，登录页会显示“已登录 · 继续”
start().catch(() => {
  goToAuth();
});
