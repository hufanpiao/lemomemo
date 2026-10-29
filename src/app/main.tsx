// 入口（架构 2.2）：挂 React、加载样式、注册 SW
// StrictMode 只在开发版开（2.6）
// 启动顺序（架构 4.1、0.27 第 1、4 点、0.38 第 17 条）：
// 0. 最先关掉 zod 的 JIT（platform/zod-jitless.ts，必须是第一个 import）
// 1. 读本机会话的 user_id（不加载 supabase-js，离线也能读）；没登录 → 跳 /app/auth/，不建本机库、不渲染
// 2. await coldStart({userId})：开本机库（迁移、换账号清库）、把上次的内容灌进集合、按缓存的 config / profile 算功能开关；
//    coldStart 不抛错，出错已降级成 unavailable（不渲染缓存，只联网用）
// 3. 定界面语言：缓存的 profiles.ui_locale → pv-locale → 设备语言 → 中文（降级时没有 profile，照样走后几层）
// 4. 按 flags 挂功能入口，再渲染（先用缓存画，同步由 K8 接着做）
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
import { watchAccount, wipeOnRemoved } from '../core/account.ts';
import { coldStart, type BootResult } from '../core/boot.ts';
import { uiStore } from '../kit/state/ui-store.ts';
import { buildInfo } from '../platform/env.ts';
import {
  clearCacheStorage, clearLocalSession, goToAuth, onAuthUser, onSessionStorageChange, readSessionUserId,
} from '../platform/session.ts';
import { registerServiceWorker, reloadPage } from '../platform/sw-register.ts';
import { App } from './App.tsx';
import { mountFeatures } from './features.ts';

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
    goToAuth();
    return;
  }

  const boot = await coldStart({ userId });
  applyLocale(boot);
  // version_too_new / unavailable 照样渲染：整屏提示和“没有离线”的提示由界面读 boot.upgrade 的状态画（接手清单 K6-ver-new）
  mountFeatures(boot.flags);

  // 换账号监听在 render 之前挂（K6 复审 N4）：挂上时同步再比一次会话，coldStart 期间已经换了账号或退出就不渲染，直接走换账号流程
  watchAccount(boot, {
    clearCacheStorage,
    onAuthUser,
    onStorageUser: (fn) => onSessionStorageChange(fn),
    currentUserId: () => readSessionUserId(),
    onSignedOut: goToAuth,
    // 清库失败（onFailed 不填）同样重新载入：冷启动会在读写任何东西之前再清一次，再失败就降级成 unavailable、不渲染缓存
    // 不删本机会话：会话是各标签页共用的，删了会把别的标签页刚登录的新账号也登出
    onSwitched: reloadPage,
  });
  if (boot.switching) return;

  createRoot(el).render(
    import.meta.env.DEV ? (
      <StrictMode>
        <App />
      </StrictMode>
    ) : (
      <App />
    ),
  );

  // 被移除、被停用（K8 发送时拿到 session_revoked / account_disabled）：清空本机、删本机会话、回登录页
  boot.outbox?.onEvent((e) => {
    if (e.type !== 'removed') return;
    void wipeOnRemoved(boot, {
      clearCacheStorage,
      onRemoved: () => {
        clearLocalSession();
        goToAuth();
      },
    });
  });

  if (!import.meta.env.DEV) void registerServiceWorker();
}

// start 自己不该抛（coldStart 不抛）；万一抛了（例如没有 #root）不留白屏：回登录页，登录页会显示“已登录 · 继续”
start().catch(() => {
  goToAuth();
});
