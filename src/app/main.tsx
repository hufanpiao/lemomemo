// 入口（架构 2.2、4.1）：装 exe 桥 → 读本机会话（没登录删库去登录页）→ coldStart → 定界面语言 → 挂功能入口 → 挂换账号监听 → 过告知页关口渲染 → 启动同步
// 不变量：换账号、会话没了的监听在 render 之前挂、挂上马上再比一次；会话没了交 core/device-exit.ts 的 exitOnSessionLoss
// 不变量：告知页关口读失败、超时、懒加载失败都不挡进 App；启动画面最多盖 5 秒、#root 第一次画出东西的下一帧收起，进退出屏时直接收；StrictMode 只在开发版开
// 每一步的理由见 docs/10-架构/历史版本/文件头原文-2026-11-11退出链路整改.md
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/tokens.css';
import '../styles/skins/simple.css';
import '../styles/skins/glass.css';
import '../styles/base.css';
import { watchAccount } from '../core/account.ts';
import type * as DeviceExit from '../core/device-exit.ts';
import { hasAuthLoss, readReauth } from '../platform/auth-loss-store.ts';
import { coldStart } from '../core/boot.ts';
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
import { gapFixWanted, startGapFix } from '../platform/vh-gapfix-gate.ts';
import {
  clearCacheStorage, clearLocalSessionIf, goToAuth, onAuthUser, onSessionStorageChange, readSessionAccessToken, readSessionId, readSessionUserId,
  markAccountUiShown, setExitNotice, takeLocalSession,
} from '../platform/session.ts';
import { settleDropAtStartup } from '../platform/session-drop.ts';
import { enableDropMark, installDesktopSession } from '../platform/session-store.ts';
import { hideSplash, hideSplashAfter } from '../platform/splash.ts';
import { afterAppPainted, appPainted, startAppPaintLimit } from '../platform/root-paint.ts';
import { watchFirstPaint, whenContent } from './first-paint.ts';
import { markInsetPainted, watchInsetBottom } from '../platform/inset-watch.ts';
import { loadMotionFeatures, loadPageSwap, nextFrame } from '../motion/index.ts';
import { registerSw, reloadPage, upgradeLogCountStore } from '../platform/sw-register.ts';
import { mountExitScreen, watchExitIncomplete } from './exit-screen.tsx';
import { flagOn, mountFeatures } from './features.ts';
import { loadTodoAutoDel } from '../features/todos/index.ts';
import { rlog } from '../platform/run-log-api.ts';
import { goHref } from './router.ts';
import { logQueueCleaner, logSink, outboxLog } from './log-channel.ts';
import { GATE_LIMIT_MS, startRoot, watchCacheBlocked, withCrashFallback } from './root.tsx';
import { AFTER_PAINT_NOTICE_AT, lazyLogUploader, loadAfterPaint, startAfterPaint, type AfterPaint } from './after-paint.ts';
import { applyUiLocale, bootLocale, ensureSharedDict } from '../platform/doc-locale.ts';
import type { UiLocale } from '../../shared/i18n/pick-locale.ts';

/** 用上界面语言（platform/doc-locale.ts：ui-store、<html lang>、页面标题） */
const applyLocale = (ui: UiLocale): void => applyUiLocale(ui, uiStore.getState());

// 诊断启动件（platform/diag-boot.ts，起运行日志）：动态下载，11-28 起正式版也下（负责人选“正式版也带”）；启动画面收起不等它
const diag = import('../platform/diag-boot.ts').then((m) => (m.startDiagBoot({ frame: nextFrame }), m)).catch(() => undefined);
// 启动画面最晚 5 秒收起，从入口模块开始执行算起
hideSplashAfter(hideSplash);
// 皮肤、深浅色：懒加载 platform/look.ts（不进首屏），加载即按本机缓存套用并盯住 settings；
// 渲染前最多等 600 毫秒（app/look-wait.ts），首屏不闪默认皮肤；超时、失败按默认皮肤渲染
const look = import('../platform/look.ts').then((m) => m.watchLook(collection<LookRow & { id: string }>('settings'), logEvent), () => undefined);
// 底部安全区：iOS 主屏幕版冷启动时先 0 后 34，稳定前底栏、“＋”不显示（platform/inset-watch.ts）
watchInsetBottom();
// Gap fix（布局视口少一截，正式版也做）：只在 iOS 主屏幕版冷启动时、启动画面还盖着时同步做一次（vh-gapfix-gate.ts）
if (gapFixWanted()) startGapFix(nextFrame);

/** exe（Tauri）里换上 exe 的 platform 桥；网页版不加载 desktop.ts */
async function installNativeBridge(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { installDesktopBridge } = await import('../platform/desktop.ts');
    installDesktopBridge(goHref); // 点 exe 通知打开整页提醒走路由，原页压进返回栈
  } catch {
    // 分包加载失败：留着网页版的桥
  }
}

/** 启动件连续下载失败时那条横幅的 id（kind 用 sync-paused，但和同步引擎那条分开，下载成功只收这一条） */
const AFTER_PAINT_BANNER_ID = 'after-paint-failed';

async function start(): Promise<void> {
  // 公共词典：这里只发起下载、不等（不串在装桥、读会话、coldStart 前面）；只在第一次画东西之前等它（退出屏、render）。
  // 下载失败改下另一种，再失败也放行（platform/doc-locale.ts）；升级被挡的整屏提示不等，词条在启动兜底里
  const firstLocale = bootLocale();
  const firstDict = ensureSharedDict(firstLocale, rlog);
  /** 第一次画东西之前：等那份词典、用上本机定的语言 */
  const readyToPaint = async (): Promise<void> => {
    await firstDict;
    applyLocale(firstLocale);
  };
  // 最先装桥：下面的 goToAuth、渲染、boot 都要用 exe 的那一份
  await installNativeBridge();
  // exe：会话存凭据管理器，在第一次读会话、建 supabase 客户端之前 preload 好；
  // 登录小窗口写好会话后整页重新载入，不在原界面树上刷新。网页版什么也不做
  const installed = await installDesktopSession(reloadPage);
  if (isTauri() && !installed) {
    // 读不到凭据管理器：不往下走（登录了也接不上），提示重新打开
    await readyToPaint();
    void hideSplash();
    mountExitScreen('unavailable');
    return;
  }
  // 上次退出时会话没删掉（“待删除”标记）：先删；删不掉只给“退出没完成，点重试”。只有主窗口记这个标记
  enableDropMark();
  if (!(await settleDropAtStartup())) {
    await readyToPaint();
    void hideSplash();
    mountExitScreen('incomplete');
    return;
  }
  const el = document.getElementById('root');
  if (!el) throw new Error('root_missing');
  // 首屏画完从这里开始算（first-paint.ts）：同步、设备登记、SW 注册都排在它后面，supabase-js 不和页面分包抢下载。
  // 这里只有 15 秒长兜底，正式时限在 render 之后才算（startAppPaintLimit）
  watchFirstPaint(nextFrame);
  // 告知页关口还在问服务器时 #root 是空的，启动画面继续盖着；一画出东西就在下一帧收起
  whenContent(el, () => void nextFrame(() => void hideSplash()));
  // 底部安全区“稳定”从首屏画完起算
  afterAppPainted(markInsetPainted);
  // 操作音效和震动：首屏画完才下载（不占首屏预算）；下载失败只是不响不震
  afterAppPainted(() => void import('../platform/feedback.ts').then((m) => m.startFx(collection<LookRow & { id: string }>('settings')), () => rlog('fx load failed')));
  el.dataset['version'] = buildInfo.version;

  const userId = readSessionUserId();
  if (!userId) {
    // 没登录：coldStart 按库名整库删掉，未同步的修改一起丢。不等删库直接去登录页：deleteDatabase 在第一个 await 之前已同步发出
    // 例外：有 lemo.reauth 且没过期是登录过期，不删库、日志队列留着，登录页提示重新登录
    const kept = readReauth() !== null;
    // 日志上传队列、外观、隐私记同意也由 coldStart 在第一个 await 之前一起清
    void coldStart({ userId: null }).catch(() => undefined);
    if (kept) goToAuth('expired', null);
    else goToAuth();
    return;
  }

  // 业务日志都进日志总线（shared/core/log-bus.ts），下面 setLogSink 接一次上传队列。
  // 断开推送失败（platform/push-disconnect.ts）：记一条，不挡退出
  setPushDisconnectLog((code) => logEvent('push_disconnect_fail', { code }));
  // 客户端错误日志：只记“类型@文件名:行号”，同一个 code 每天 5 条
  registerJsErrorLog(logEvent);
  // 日志队列存 localStorage lemo.logq.<user_id>，主页在线时批量上传；别的账号留下的队列清掉
  clearOtherLogQueues(userId);
  // 上传前核对会话主人：别的标签页换了账号，不能用新账号的令牌传这个账号的日志。
  // 上传端第一次真上传才加载（lazyLogUploader，sync-net 不进首屏）；加载失败这一批回 retry
  const logQueue = createLogQueue({
    store: logQueueStore(userId), upload: guardOwner(userId, readSessionUserId, lazyLogUploader()),
    isOnline: () => browserLifecycle.isOnline(), onOnline: (fn) => browserLifecycle.onOnline(fn),
  });
  setLogSink(logSink(logQueue, rlog));
  // 上次会话丢失的原因码：只上传 uid_h 对得上本账号的，别的丢；取完整个键删掉。有这个键才动态引入（auth-loss-log.ts 不进首屏）
  if (hasAuthLoss()) void import('../platform/auth-loss-log.ts')
    .then(async (m) => (await m.takeAuthLossFor(userId, readInstallId())).forEach((e) => logEvent('auth_loss', { code: m.authLossLogCode(e) })))
    .catch(() => undefined);
  // 被移除、停用、注销冷静期、SIGNED_OUT：停止上传并清掉这个账号的日志队列；lossExit 和 wireSync 共用这一个
  const clearLogs = logQueueCleaner(logQueue, userId);
  /** 已按 boot 的 profile 定过界面语言（之后 blocked 也不再按“没有 profile”覆盖） */
  let localeFromBoot = false;
  const boot = await coldStart({
    userId,
    outboxOptions: { log: outboxLog(logEvent) },
    // 别的标签页删了本机库：会话没了回登录页（重复跳转无害），还有（那边已重新登录）就重新载入
    onCacheDeleted: () => (readSessionUserId() ? reloadPage() : goToAuth()),
    // 升级中心的错误码进日志总线；同一个 act 每天最多 5 条，计数在 localStorage lemo.upglog
    upgradeDeps: { log: (act, code) => logEvent(act, code ? { code } : undefined), logCounts: upgradeLogCountStore },
    // 升级本机库被别的标签页挡住时整屏提示（root.tsx）。这时 profile 还没读出来：第一次被挡、提示画出来之前
    // 才按本机或设备语言定一次界面语言；已经按 profile 定过就不覆盖
    onUpgradeCenter: (u) => {
      watchCacheBlocked(u, { onFirstBlocked: () => (localeFromBoot ? undefined : applyLocale(firstLocale)) });
    },
  });
  // profile 定的语言和先发起的不一样时也下载那份，两份一起在 render 之前等
  const uiLocale = bootLocale(boot.profile?.['ui_locale']);
  const dictReady = uiLocale === firstLocale ? firstDict : Promise.all([firstDict, ensureSharedDict(uiLocale, rlog)]);
  // unavailable 照样渲染 App（只联网用）；version_too_new 只渲染整屏提示（下面），不挂功能入口
  mountFeatures(boot.flags);

  // 换账号监听在 render 之前挂：挂上时同步再比一次会话，coldStart 期间已换账号或退出就不渲染
  // 会话没了走 core/device-exit.ts：关连接后按库名删库；不广播 reset（别的标签页各自收得到 storage 事件）
  // 退出出口会话真没了才下载（不进首屏）：本来就要等 REAUTH_GRACE_MS 再判断，多等下载不改结果
  const lossExit = (m: typeof DeviceExit): DeviceExit.ExitDeps => ({
    ...m.defaultExitDeps,
    getBoot: () => boot,
    clearLogs,
    broadcastReset: () => undefined,
    log: logEvent,
  });
  watchAccount(boot, {
    clearCacheStorage,
    onAuthUser,
    onStorageUser: (fn) => onSessionStorageChange(fn),
    currentUserId: () => readSessionUserId(),
    // SIGNED_OUT：判断会话归谁的同一刻就删本机会话，回登录页前只在会话还是那一个时再删
    takeSession: () => takeLocalSession(),
    // 别的标签页删了会话：等它写好 lemo.reauth 再判断是登录过期还是退出；下载失败直接回登录页
    onSessionLost: (loss) => void import('../core/device-exit.ts').then((m) => m.exitOnSessionLoss(loss, lossExit(m), m.REAUTH_GRACE_MS)).catch(() => goToAuth()),
    // 清库失败同样重新载入：冷启动读写前会再清一次，再失败降级成 unavailable
    // 不删本机会话：各标签页共用，删了会把别的标签页刚登录的新账号也登出
    onSwitched: reloadPage,
  });
  if (boot.switching) return;
  // 推送认领上下文首屏画完才设：这之前点按认领先等它，不当场回 claim_failed
  expectPushClaimContext();

  // 选根（root.tsx）：在线先过告知页关口；本机库来自更新的版本只渲染整屏提示（先注册 SW 再渲染，不盯新版本）
  const root = await startRoot(boot, {
    online: browserLifecycle.isOnline(),
    onRefresh: reloadPage,
    ...(import.meta.env.DEV ? {} : { registerSw }),
  });
  // 最外层兜底：App 顶层出错不白屏
  const guarded = withCrashFallback(root, reloadPage);
  // 第一次画 App 之前：等皮肤（最多 600 毫秒）和公共词典，用上 profile 定的语言
  await Promise.all([waitLook(look), dictReady]);
  applyLocale(uiLocale);
  localeFromBoot = true;
  createRoot(el).render(import.meta.env.DEV ? <StrictMode>{guarded}</StrictMode> : guarded);
  const renderAt = performance.now();
  // 首屏时限从 render 起算：告知页关口最多空白 GATE_LIMIT_MS 后一定画出页面，时限再加 1 秒，
  // 关口慢时同步也不会抢先起、和告知页分包抢下载
  startAppPaintLimit(GATE_LIMIT_MS + 1000);
  // 账号界面画出来了：exe 里之后退出、被移除时先整页重新载入，再开登录小窗口
  markAccountUiShown();
  // exe：之后删会话失败时盖上“退出没完成，点重试”；网页版不会出现
  if (isTauri()) watchExitIncomplete();

  // 等第一个页面画出来再起同步：同步引擎一启动就要 supabase-js，不能抢在页面分包前下载。watchAccount 已在 render 前挂好。
  // 取舍：会话被撤销、账号停用要等同步引擎起来才发现，最多推后几百毫秒
  await appPainted();
  // 等的时候可能已经在换账号、退出：后面的同步、设备登记、推送认领、SW 注册一律不再做，等着上下文的点按认领立刻回 claim_failed。
  // 同步再比一次本机会话：别的标签页换了账号、watchAccount 还没设闸时同样不做。下载启动件前后的闸也是这一个
  const stillOwner = (): boolean => !boot.switching && readSessionUserId() === userId;
  if (!stillOwner()) {
    setPushClaimContext(null);
    return;
  }
  // 冷启动开始渲染、首屏画完离页面导航多少毫秒。放在闸后面：await appPainted() 必须紧跟换账号检查（first-paint-wiring 测试）
  rlog(`boot render=${Math.round(renderAt)} painted=${Math.round(performance.now())}`);
  // SW 注册不依赖下面那批代码：过了闸就注册，下载失败、重试期间照样有 SW 缓存和新版本提示。version_too_new 时上面已注册过
  // 注册后盯住后台装好的新版本，顶部提示重新打开（UpdateBanner），不强制刷新。
  // 注册代码这时才下载（platform/sw-lifecycle.ts）；下载、注册都不设超时，推送认领等到 reg，失败才是 null
  const swReg: Promise<ServiceWorkerRegistration | null> =
    !import.meta.env.DEV && boot.status !== 'version_too_new'
      ? // 再兜一层：抛错按“没注册”处理，不留没处理的拒绝
        registerSw({ onReady: () => boot.upgrade.setSwReady(), life: browserLifecycle }).catch(() => null)
      : Promise.resolve(null);

  // 完成满 7 天、没再动过的待办自动删除：同步第一次拉取成功后才扫（onFirstPull；不拿没跟上服务器的旧数据扫），和手动删除同一写法进 outbox。
  // 本机库能用、待办功能开着才扫；代码按需下载（features/todos/data/todo-autodel.ts），下载失败记运行日志，下次启动再扫
  const todoAutoDel = (): void => {
    if (!stillOwner() || !boot.cache || !flagOn(boot.flags, 'todo')) return;
    void loadTodoAutoDel().then((m) => m.runTodoAutoDel(), () => rlog('todo autodel err=load'));
  };

  /** 下载到了、闸也过了（startAfterPaint 保证）：起同步、设备登记、推送认领。这里面全是同步调用，查完闸到用上账号之间没有空档 */
  const startSync = (late: AfterPaint): void => {
    const { createSupabaseTransport, createDeviceRegistrar, wireSync, probeAccountForExit } = late;

    // 同步只在 boot 正常时启动；被移除只处理一次：清空本机、删本机会话、回登录页
    // 设备行：主页拿到锁后登记或复用本会话的 devices 行，id 存 meta，report_tz 用它
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
      transport, goToAuth, platform, log: logEvent,
      // 第二个参数是 sid（被拒那次请求的会话），不是 session 的 setExitNotice 的 storage，要包一层
      setExitNotice: (n, sid) => setExitNotice(n, undefined, { sid: sid ?? null }),
      // 被移除、停用：一收到就删被拒那次请求的会话（sid 必填），回登录页前只在会话还是那一个时再删
      clearLocalSessionIf: (sid) => clearLocalSessionIf(sid),
      // account_disabled 先用被拒那次会话的令牌探测是停用还是注销冷静期
      probeAccount: (token) => probeAccountForExit({ token }),
      readSession: () => ({ sid: readSessionId(), token: readSessionAccessToken() }),
      readUserId: () => readSessionUserId(),
      reload: reloadPage,
      // 限次触发、已让出同步主页：顶部出“同步暂停”（UpdateBanner 读 ui-store 的 sync-paused）
      onSyncPaused: () => uiStore.getState().pushBanner({ id: 'sync-paused', kind: 'sync-paused' }),
      onLeader: (on) => logQueue.setLeader(on),
      clearLogs,
      onFirstPull: todoAutoDel,
      ...(device ? { deviceId: device.id, ensureDevice: device.ensure } : {}),
    });

    // 推送认领参数由 platform/push-claim-run.ts 统一拼，启动认领和设置里的点按认领用同一份
    setPushClaimContext({
      userId, platform, claim: (a) => transport.claimEndpoint(a), sessionId: () => readSessionId(), currentUserId: () => readSessionUserId(),
      ...(device ? { ensureDevice: device.ensure, invalidateDevice: device.invalidate } : {}),
    });

    // 推送订阅：SW 注册好了才认领；权限已给就重订到这个账号，没给不弹权限框（只在设置里点按时请求）
    // 先等设备行登记好再认领；几个标签页串着来；结果写进 push-status 给设置页
    void swReg.then((reg) => {
      if (reg) void runPushClaim();
    });
  };

  // 同步、设备登记、账号探测的代码这时才下载（after-paint.ts，zod、supabase 封装不进首屏）。
  // 下载失败、超时：退避重试，恢复网络、切回前台立刻再试；每次下载前、回来后都过同一道换账号闸。
  // 第一次失败就设 null 推送认领上下文（点按认领当场回 claim_failed），成功后再设；本机缓存照常能看能改。
  // 连续失败 AFTER_PAINT_NOTICE_AT 次：顶部出 sync-paused 横幅（重新打开也绕开浏览器缓存失败的动态 import）
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
  // 动画实现：首屏画完后下载，门面在安全时机换成动画实现（src/motion/features.ts）；失败不抛，只是没有动画
  void loadMotionFeatures();
  // 换页动画同一时机下载（不进首屏）
  void loadPageSwap();
  // 不是触屏时：滚动条平时藏起、滚动时浮出柠檬黄细条（motion/scrollbar-reveal.ts）；下载失败就照旧用原生滚动条。
  // 条件写“不是 pointer: coarse”，不写“是 pointer: fine”：有的 Windows 电脑插着鼠标，Chromium 却报 pointer: none，
  // 那样黄条装不上、露出系统灰条（运行日志开头行 ptr= 记着这台机器报的是哪种）
  if (!matchMedia('(pointer: coarse)').matches) {
    void import('../motion/scrollbar-reveal.ts').then((m) => m.installScrollbarReveal(), () => undefined);
  }
}

/** 启动失败时最多等运行日志接上多久再跳登录页（诊断启动件下载卡住也不多等） */
const BOOT_FAIL_LOG_WAIT_MS = 1000;

// start 万一抛了（例如没有 #root）不留白屏：回登录页。先经 diag-boot.ts 的 logBootFailed 记一行（不记 message），
// 最多等 BOOT_FAIL_LOG_WAIT_MS；入口不静态引 run-log（diag-boot.test.ts）（11-28 起正式版也有 diag）
start().catch((e: unknown) => {
  void Promise.race([diag?.then((m) => m?.logBootFailed(e)), new Promise((r) => setTimeout(r, BOOT_FAIL_LOG_WAIT_MS))]).then(() => goToAuth());
});
