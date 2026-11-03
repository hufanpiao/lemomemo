// 入口（架构 2.2）：挂 React、加载样式、注册 SW
// StrictMode 只在开发版开（2.6）
// 启动顺序（架构 4.1、0.27 第 1、4 点、0.38 第 17 条）：
// 0. 最先关掉 zod 的 JIT（platform/zod-jitless.ts，必须是第一个 import）；进 start 后第一件事是 exe 里装 platform 桥（isTauri 才动态 import desktop.ts，0.53 第 2 条）
// 1. 读本机会话的 user_id（不加载 supabase-js，离线也能读）；没登录 → 本机库还在就删掉，跳 /app/auth/，不建本机库、不渲染
// 2. await coldStart({userId})：开本机库（迁移、换账号清库）、把上次的内容灌进集合、按缓存的 config / profile 算功能开关；
//    coldStart 不抛错，出错已降级成 unavailable（不渲染缓存，只联网用）
// 3. 定界面语言：缓存的 profiles.ui_locale → pv-locale → 设备语言 → 中文（降级时没有 profile，照样走后几层）
// 4. 按 flags 挂功能入口，再渲染（先用缓存画），然后启动 K8 同步（sync-wiring.ts，主页顺带登记本会话的 devices 行、报时区）；本机库来自更新的版本时只渲染整屏提示 CacheTooNewScreen
// 5.（在 render 之前）盯住换账号的另外三个时机：本页 SIGNED_IN、TOKEN_REFRESHED（supabase-js 空闲时才加载），别的标签页的 storage 事件；
//    挂上后马上再读一次会话比一次，补上 1 到 5 之间漏掉的变化（K6 审查 M1）
// 6.（mountFeatures 之后、渲染 App 之前，接手清单 CONSENT-wire ②）在线时先过告知页关口 ConsentGate（features/onboarding）：
//    它问 noticeState()，first 先显示告知页（排在通知、麦克风说明之前），updated 留给“隐私说明更新了”那一屏（还没做，现在直接进 App），
//    读失败、超过 3 秒（CONSENT-sugg ①）、懒加载失败都不挡进 App。noticeState 在关口里调而不是在这里 await：A27 只许 app 经 index.ts
//    拿懒加载的组件，拿不到 data 层的函数；#root 本来是空的，关口回答之前不画 App，看起来和“等完再渲染”一样，同步也不用跟着等。
//    选根（关口、离线、version_too_new）在 root.tsx（CONSENT-sugg ③⑥：错误边界只包关口，单独有测试）；
//    选出来的根外面再包一层静态的“出错了 · 刷新”兜底（root.tsx 的 withCrashFallback，K6-sugg3 ⑥）
// 启动画面（R-251、R-254；DOM 在 index.html，跟着首次绘制出来）：从这里起算最多盖 5 秒（hideSplashAfter）；
// #root 第一次画出东西（告知页、App、整屏提示、崩溃兜底页）的下一帧收起（hideSplashWhenPainted）；root.tsx 的 SplashRelease 再各收一次
import '../platform/zod-jitless.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/tokens.css';
import '../styles/skins/simple.css';
import '../styles/skins/glass.css';
import '../styles/base.css';
import { fromUiLocale, LOCALE_STORAGE_KEY, pickLocale, toUiLocale } from '../../shared/i18n/pick-locale.ts';
import { watchAccount } from '../core/account.ts';
import { coldStart, type BootResult } from '../core/boot.ts';
import { deleteCacheDb } from '../core/cache.ts';
import { createDeviceRegistrar } from '../core/device-reg.ts';
import { createLogQueue, guardOwner } from '../core/log/queue.ts';
import { devicePlatform, readInstallId, withLock } from '../platform/device-info.ts';
import { clearLogQueue, clearOtherLogQueues, logQueueStore } from '../platform/log-store.ts';
import { probeAccountForExit } from '../platform/account-status.ts';
import { ensurePushSubscription } from '../platform/push-claim.ts';
import { browserLifecycle } from '../platform/net.ts';
import { createLogUploader, createSupabaseTransport } from '../platform/sync-net.ts';
import { uiStore } from '../kit/state/ui-store.ts';
import { buildInfo, isTauri, registerJsErrorLog } from '../platform/env.ts';
import {
  clearCacheStorage, clearLocalSessionIf, goToAuth, onAuthUser, onSessionStorageChange, readSessionAccessToken, readSessionId, readSessionUserId,
  markAccountUiShown, setExitNotice, takeLocalSession,
} from '../platform/session.ts';
import { settleDropAtStartup } from '../platform/session-drop.ts';
import { enableDropMark, installDesktopSession } from '../platform/session-store.ts';
import { hideSplash, hideSplashAfter, hideSplashWhenPainted } from '../platform/splash.ts';
import { nextFrame } from '../motion/index.ts';
import { checkSwOnForeground, registerServiceWorker, reloadPage, upgradeLogCountStore, watchServiceWorkerUpdate } from '../platform/sw-register.ts';
import { mountExitScreen, watchExitIncomplete } from './ExitIncompleteScreen.tsx';
import { mountFeatures } from './features.ts';
import { createLogChannel, logQueueCleaner, outboxLog } from './log-channel.ts';
import { startRoot, watchCacheBlocked, withCrashFallback } from './root.tsx';
import { wireSync } from './sync-wiring.ts';
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

// 启动画面最晚 5 秒收起：从入口模块开始执行算起（关口、冷启动、分包加载哪一步卡住都不再盖着）
hideSplashAfter();

/** exe（Tauri）里换上 exe 的 platform 桥（架构 0.53 第 2 条）：openReminder、openAuth、本机通知改走 exe；网页版不加载 desktop.ts */
async function installNativeBridge(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { installDesktopBridge } = await import('../platform/desktop.ts');
    installDesktopBridge();
  } catch {
    // 分包加载失败：留着网页版的桥（照常能用，只是 exe 专有的几件退回网页做法）
  }
}

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
  // 告知页关口还在问服务器时 #root 是空的，启动画面继续盖着；一画出东西就在下一帧收起
  hideSplashWhenPainted(el, nextFrame);
  el.dataset['version'] = buildInfo.version;

  const userId = readSessionUserId();
  if (!userId) {
    // 没登录：库还在就按库名整库删掉（coldStart 的 signed_out 分支），未同步的修改一起丢（R-231）。
    // 不等删库，直接去登录页（登录页审查建议 2）：coldStart 在第一个 await 之前就同步发出了 deleteDatabase，跳转不影响它执行
    void coldStart({ userId: null }).catch(() => undefined);
    // 日志上传队列一起清（架构 0.38 第 68 条 ⑤；K6-signedout 审查建议 1）：没有会话时哪个账号的都不该留
    clearLogQueue(null);
    goToAuth();
    return;
  }

  // 日志通道（K8-logs、K6-log）：outbox、同步、时区上报、设备登记都交到这里；写 logs 表的那一端接上以前先在内存里留着（log-channel.ts）
  const logs = createLogChannel();
  // 客户端错误日志（TC-B1-68、架构 6.1）：只记“类型@文件名:行号”，同一个 code 每天 5 条
  registerJsErrorLog(logs.log);
  // 写 logs 表的那一端（架构 0.38 第 68 条）：localStorage 队列 lemo.logq.<user_id>，主页在线时批量上传；别的账号留下的队列清掉
  clearOtherLogQueues(userId);
  // 上传前核对会话主人：别的标签页换成了别的账号，这一页拿到的是新账号的令牌，不能用它传这个账号的日志
  const logQueue = createLogQueue({
    store: logQueueStore(userId), upload: guardOwner(userId, readSessionUserId, createLogUploader()),
    isOnline: () => browserLifecycle.isOnline(), onOnline: (fn) => browserLifecycle.onOnline(fn),
  });
  logs.setSink((e) => logQueue.add(e));
  // 被移除、停用、注销冷静期、本页收到 SIGNED_OUT：停止上传并清掉这个账号的日志队列（架构 0.38 第 68 条）；watchAccount（K6-signedout）和 wireSync 共用
  const clearLogs = logQueueCleaner(logQueue, userId);
  /** 已按 boot 的 profile 定过界面语言（之后 blocked 也不再按“没有 profile”覆盖） */
  let localeFromBoot = false;
  const boot = await coldStart({
    userId,
    outboxOptions: { log: outboxLog(logs.log) },
    // 别的标签页退出登录、按库名删本机库（versionchange 的 newVersion 为 null，K6 复审 C）：同步读一次会话，
    // 没有了就回登录页（库正在被删，watchAccount 收到 storage 事件后也会走退出流程，重复跳转无害）；还有（那边已重新登录）就重新载入
    onCacheDeleted: () => (readSessionUserId() ? reloadPage() : goToAuth()),
    // 升级中心的错误码（update_failed、update_takeover_timeout、upgrade_busy_expired 等，PROBE-sugg2 ③）进同一条日志通道；
    // 同一个 act 每天最多 5 条，计数在 localStorage lemo.upglog（B 组审查建议 1）
    upgradeDeps: { log: (act, code) => logs.log(act, code ? { code } : undefined), logCounts: upgradeLogCountStore },
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
  watchAccount(boot, {
    clearCacheStorage,
    clearLogs,
    onAuthUser,
    onStorageUser: (fn) => onSessionStorageChange(fn),
    currentUserId: () => readSessionUserId(),
    // 本页收到 SIGNED_OUT：判断会话归谁的同一刻就删本机会话，回登录页前只在会话还是那一个时再删（K6-signedout-sugg2 ①）
    dropSession: () => takeLocalSession(),
    onSignedOut: goToAuth,
    // 别的标签页退出：本页关掉连接后按库名删库（登录页审查）
    deleteDb: () => deleteCacheDb(),
    // 清库失败（onFailed 不填）同样重新载入：冷启动会在读写任何东西之前再清一次，再失败就降级成 unavailable、不渲染缓存
    // 不删本机会话：会话是各标签页共用的，删了会把别的标签页刚登录的新账号也登出
    onSwitched: reloadPage,
  });
  if (boot.switching) return;

  // 选根（root.tsx）：在线先过告知页关口；本机库来自更新的版本（TC-B1-49，K6-ver-new）只渲染整屏提示（先注册 SW 再渲染，复审 S4）
  const root = await startRoot(boot, {
    online: browserLifecycle.isOnline(),
    onRefresh: reloadPage,
    ...(import.meta.env.DEV ? {} : { registerSw: registerServiceWorker }),
  });
  // 最外层兜底（K6-sugg3 ⑥）：App 顶层出错不白屏，显示静态的“出错了 · 刷新”
  const guarded = withCrashFallback(root, reloadPage);
  createRoot(el).render(import.meta.env.DEV ? <StrictMode>{guarded}</StrictMode> : guarded);
  // 账号的界面画出来了：exe 里之后退出、被移除时先整页重新载入，再开登录小窗口（FA2-3）
  markAccountUiShown();
  // exe：之后退出、被移除时删会话失败，盖上“退出没完成，点重试”（A-1）；网页版不会出现
  if (isTauri()) watchExitIncomplete();

  // 同步（K8）：只在 boot 正常时启动；被移除（同步引擎、outbox 的 removed 事件）只处理一次：清空本机、删本机会话、回登录页
  // 设备行（0.38 第 62 条④，接手清单 K8-tz-device）：主页拿到锁后登记或复用本会话的 devices 行，id 存 meta，report_tz 用它
  const transport = createSupabaseTransport();
  const platform = devicePlatform();
  const device = boot.cache
    ? createDeviceRegistrar({
        transport, cache: boot.cache, platform, appVersion: buildInfo.version,
        sessionId: () => readSessionId(), installId: () => readInstallId(),
        lock: (fn) => withLock(`lemo-device-reg:${userId}`, fn), log: logs.log,
      })
    : null;
  wireSync(boot, {
    transport, clearCacheStorage, goToAuth, platform, log: logs.log,
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

  // version_too_new 时上面已经注册过
  // 注册以后盯住“后台装好了新版本”（8.1）：顶部提示“有新版本 · 重新打开”（App.tsx 的 UpdateBanner），不强制刷新
  if (!import.meta.env.DEV && boot.status !== 'version_too_new') {
    void registerServiceWorker().then((reg) => {
      if (!reg) return;
      watchServiceWorkerUpdate(reg, () => boot.upgrade.setSwReady());
      // 切到前台、在线、距上次查满 1 小时才主动查新版本（架构师 10-30 第 5 点；和同步引擎“切到前台时比较最低版本”同一个时机）
      checkSwOnForeground(reg, { life: browserLifecycle });
      // 推送订阅（FA-1；换账号时旧订阅已退订，FE-2）：通知权限已给就重订、认领到这个账号；没给不弹权限框（只在设置 › 提醒的点按里请求）
      // 先等本会话的设备行登记好再认领（代码审查 M3、安全审查 S1）；记录按“账号 + 会话 + endpoint”的摘要（FA2-1、FA2-2）；几个标签页串着来（S2）
      void ensurePushSubscription({
        userId, platform, claim: (a) => transport.claimEndpoint(a), sessionId: () => readSessionId(),
        ...(device ? { ensureDevice: device.ensure, invalidateDevice: device.invalidate } : {}),
        lock: (fn) => withLock(`lemo-push-claim:${userId}`, fn),
      });
    });
  }
}

// start 自己不该抛（coldStart 不抛）；万一抛了（例如没有 #root）不留白屏：回登录页，登录页会显示“已登录 · 继续”
start().catch(() => {
  goToAuth();
});
