// 入口（架构 2.2）：挂 React、加载样式、注册 SW
// StrictMode 只在开发版开（2.6）
// 启动顺序（架构 4.1、0.27 第 1、4 点、0.38 第 17 条）：
// 0. 最先关掉 zod 的 JIT（platform/zod-jitless.ts，必须是第一个 import）
// 1. 读本机会话的 user_id（不加载 supabase-js，离线也能读）；没登录 → 本机库还在就删掉，跳 /app/auth/，不建本机库、不渲染
// 2. await coldStart({userId})：开本机库（迁移、换账号清库）、把上次的内容灌进集合、按缓存的 config / profile 算功能开关；
//    coldStart 不抛错，出错已降级成 unavailable（不渲染缓存，只联网用）
// 3. 定界面语言：缓存的 profiles.ui_locale → pv-locale → 设备语言 → 中文（降级时没有 profile，照样走后几层）
// 4. 按 flags 挂功能入口，再渲染（先用缓存画），然后启动 K8 同步（sync-wiring.ts）；本机库来自更新的版本时只渲染整屏提示 CacheTooNewScreen
// 5.（在 render 之前）盯住换账号的另外三个时机：本页 SIGNED_IN、TOKEN_REFRESHED（supabase-js 空闲时才加载），别的标签页的 storage 事件；
//    挂上后马上再读一次会话比一次，补上 1 到 5 之间漏掉的变化（K6 审查 M1）
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
import { createSupabaseTransport } from '../platform/sync-net.ts';
import { uiStore } from '../kit/state/ui-store.ts';
import { buildInfo } from '../platform/env.ts';
import {
  clearCacheStorage, clearLocalSession, goToAuth, onAuthUser, onSessionStorageChange, readSessionUserId, setExitNotice,
} from '../platform/session.ts';
import { registerServiceWorker, reloadPage } from '../platform/sw-register.ts';
import { App } from './App.tsx';
import { CacheTooNewFallback } from './CacheTooNewFallback.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { mountFeatures } from './features.ts';
import { wireSync } from './sync-wiring.ts';

/** 界面语言（16.4）：缓存的 profiles.ui_locale → 本机选过的（pv-locale）→ 设备语言 → 中文；规则同 src/auth/main.tsx，多一层缓存的 profile */
function applyLocale(boot: BootResult): void {
  const cachedUi = boot.profile?.['ui_locale'];
  let savedLocal: string | null = null;
  try {
    savedLocal = localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    savedLocal = null;
  }
  const uiLocale = toUiLocale(pickLocale(fromUiLocale(typeof cachedUi === 'string' ? cachedUi : null) ?? savedLocal, navigator.languages));
  uiStore.getState().setLocale(uiLocale);
  document.documentElement.lang = uiLocale;
}

async function start(): Promise<void> {
  const el = document.getElementById('root');
  if (!el) throw new Error('root_missing');
  el.dataset['version'] = buildInfo.version;

  const userId = readSessionUserId();
  if (!userId) {
    // 没登录：库还在就按库名整库删掉（coldStart 的 signed_out 分支），未同步的修改一起丢（R-231）。
    // 不等删库，直接去登录页（登录页审查建议 2）：coldStart 在第一个 await 之前就同步发出了 deleteDatabase，跳转不影响它执行
    void coldStart({ userId: null }).catch(() => undefined);
    goToAuth();
    return;
  }

  const boot = await coldStart({
    userId,
    // 别的标签页退出登录、按库名删本机库（versionchange 的 newVersion 为 null，K6 复审 C）：同步读一次会话，
    // 没有了就回登录页（库正在被删，watchAccount 收到 storage 事件后也会走退出流程，重复跳转无害）；还有（那边已重新登录）就重新载入
    onCacheDeleted: () => (readSessionUserId() ? reloadPage() : goToAuth()),
  });
  applyLocale(boot);
  // unavailable 照样渲染 App（只联网用）；version_too_new 只渲染整屏提示（下面），不挂功能入口
  mountFeatures(boot.flags);

  // 换账号监听在 render 之前挂（K6 复审 N4）：挂上时同步再比一次会话，coldStart 期间已经换了账号或退出就不渲染，直接走换账号流程
  watchAccount(boot, {
    clearCacheStorage,
    onAuthUser,
    onStorageUser: (fn) => onSessionStorageChange(fn),
    currentUserId: () => readSessionUserId(),
    onSignedOut: goToAuth,
    // 别的标签页退出：本页关掉连接后按库名删库（登录页审查）
    deleteDb: () => deleteCacheDb(),
    // 清库失败（onFailed 不填）同样重新载入：冷启动会在读写任何东西之前再清一次，再失败就降级成 unavailable、不渲染缓存
    // 不删本机会话：会话是各标签页共用的，删了会把别的标签页刚登录的新账号也登出
    onSwitched: reloadPage,
  });
  if (boot.switching) return;

  // 本机库来自更新的版本（TC-B1-49，K6-ver-new）：整屏提示“请更新 App”，只给“去更新 / 刷新”，不给继续使用；懒加载，不进主包
  // • 先注册 SW 再渲染（复审 S4）：“去更新”靠 SW，首次打开还没注册时会误报“更新失败”
  // • 懒加载失败、整屏组件出错：回退到不懒加载的静态提示（一句话＋刷新），不跳登录页（复审 S1、S2）
  let root = <App />;
  if (boot.status === 'version_too_new') {
    if (!import.meta.env.DEV) await registerServiceWorker();
    const fallback = <CacheTooNewFallback onRefresh={reloadPage} />;
    try {
      const { CacheTooNewScreen } = await import('./CacheTooNewScreen.tsx');
      root = (
        <ErrorBoundary fallback={fallback}>
          <CacheTooNewScreen upgrade={boot.upgrade} onRefresh={reloadPage} />
        </ErrorBoundary>
      );
    } catch {
      root = fallback;
    }
  }
  createRoot(el).render(import.meta.env.DEV ? <StrictMode>{root}</StrictMode> : root);

  // 同步（K8）：只在 boot 正常时启动；被移除（同步引擎、outbox 的 removed 事件）只处理一次：清空本机、删本机会话、回登录页
  wireSync(boot, { transport: createSupabaseTransport(), clearCacheStorage, clearLocalSession, goToAuth, setExitNotice });

  // version_too_new 时上面已经注册过
  if (!import.meta.env.DEV && boot.status !== 'version_too_new') void registerServiceWorker();
}

// start 自己不该抛（coldStart 不抛）；万一抛了（例如没有 #root）不留白屏：回登录页，登录页会显示“已登录 · 继续”
start().catch(() => {
  goToAuth();
});
