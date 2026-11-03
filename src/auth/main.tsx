// 登录页入口 /app/auth/（架构 15.6 第 4b 条：Vite 的第二个入口，只带登录、邀请需要的代码）
// - 只有这一页的 CSP 放行 https://challenges.cloudflare.com（src/_headers 的 /app/auth/* 一段）
// - 不注册 SW（主 App 注册；这一页也在 /app/ 作用域里，装好的 SW 会预缓存它）
// - 登录成功后跳回 /app/（同源，supabase-js 的会话存储共用）；exe 的登录小窗口改存凭据管理器（platform/session-store.ts），由 Rust 通知主窗口
// - 现在这一页的包里没有 zod（2026-10-29 按构建产物核对过），所以不调 z.config({ jitless: true })；
//   以后登录页一旦引入 zod（含 shared/schema），要在这里第一行调它，否则 zod 4 的 allowsEval 探测在严格 CSP 下报 eval 违规
import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/tokens.css';
import '../styles/skins/simple.css';
import '../styles/base.css';
import { LOCALE_STORAGE_KEY, pickLocale } from '../../shared/i18n/pick-locale.ts';
import { AuthPage } from '../features/auth/index.ts';
import { uiStore } from '../kit/state/ui-store.ts';
import { applyDocLocale } from '../platform/doc-locale.ts';
import { buildInfo } from '../platform/env.ts';
import { installDesktopSession } from '../platform/session-store.ts';

/** 界面语言：本机选过的（pv-locale）→ 设备语言 → 中文（16.4）；页面标题跟着换（K-16：韩文“레모”） */
function savedLocale(): string | null {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}
const locale = pickLocale(savedLocale(), navigator.languages) === 'ko' ? 'ko-KR' : 'zh-CN';
uiStore.getState().setLocale(locale);
applyDocLocale(locale);

const el = document.getElementById('root');
if (!el) throw new Error('root_missing');
el.dataset['version'] = buildInfo.version;
const root = el;

const page = (
  <Suspense fallback={null}>
    <AuthPage />
  </Suspense>
);

// exe 的登录小窗口：会话写进凭据管理器（F5-2 / N1），渲染（读会话、建 supabase 客户端）之前先 preload 好；网页版直接渲染
void installDesktopSession().finally(() => {
  createRoot(root).render(import.meta.env.DEV ? <StrictMode>{page}</StrictMode> : page);
});
