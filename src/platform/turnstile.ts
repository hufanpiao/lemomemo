// Cloudflare Turnstile（架构 15.2 中 1 ①、15.6 第 4b 条）：只在登录页 /app/auth/ 用
// - 脚本从 https://challenges.cloudflare.com 加载；只有 /app/auth/ 的 CSP 放行它（src/_headers），主 App 里调用会被 CSP 拦
// - 站点密钥是公开值，从 VITE_PUBLIC_TURNSTILE_SITE_KEY 读（构建时由 CI 的 PREVIEW_/PROD_TURNSTILE_SITE_KEY 变量给）；
//   没给时（本机开发、e2e、还没拿到正式值的预览）用 Cloudflare 官方的测试站点密钥做桩；正式版没给或给的是测试密钥，构建直接失败（vite.config.ts）
// - 令牌只能用一次：每次提交以后调 reset() 换一个新的
import { buildInfo } from './env.ts';

/**
 * Cloudflare 官方公开的测试站点密钥（https://developers.cloudflare.com/turnstile/troubleshooting/testing/）：
 * 总是通过、显示小窗。它产生的假令牌只有配上官方测试 secret 的服务器才认，
 * 所以 Supabase 的 CAPTCHA 用正式 secret 时，桩只能走到“人机验证没通过”。
 */
export const TURNSTILE_TEST_SITEKEY = '1x00000000000000000000AA';

/** 官方测试站点密钥都形如 1x/2x/3x + 20 个 0 + 两位字母（总是通过、总是拦、强制交互等） */
export function isTestSiteKey(key: string): boolean {
  return /^[1-3]x0{20}[A-Z]{2}$/.test(key);
}

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
export const TURNSTILE_SCRIPT = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit`;

/** 当前构建用哪一把站点密钥（正式版不准退回测试密钥） */
export function turnstileSiteKey(info: { turnstileSiteKey: string; env: string } = buildInfo): string {
  const key = info.turnstileSiteKey.trim();
  // 正式版运行时再挡一次（构建时 vite.config.ts 已挡；安全审查 6）：不给、给的是测试密钥都拒绝
  if (info.env === 'production' && isTestSiteKey(key)) throw new Error('turnstile_test_sitekey_in_production');
  if (key) return key;
  if (info.env === 'production') throw new Error('turnstile_sitekey_missing');
  return TURNSTILE_TEST_SITEKEY;
}

export interface TurnstileRenderOptions {
  sitekey: string;
  language?: string;
  action?: string;
  callback?: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: (code: string) => void;
}

/** api.js 挂在 window.turnstile 上的那几个方法（只声明用到的） */
export interface TurnstileApi {
  render(el: HTMLElement, opts: TurnstileRenderOptions): string;
  reset(id: string): void;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

/** 加载 api.js（整页只加一次）；加载失败时下次再调会重新试 */
export function loadTurnstile(doc: Document = document): Promise<TurnstileApi> {
  const win = doc.defaultView;
  if (win?.turnstile) return Promise.resolve(win.turnstile);
  if (!loading) {
    loading = new Promise<TurnstileApi>((resolve, reject) => {
      const s = doc.createElement('script');
      s.src = TURNSTILE_SCRIPT;
      s.async = true;
      s.defer = true;
      s.addEventListener('load', () => {
        const api = doc.defaultView?.turnstile;
        if (api) resolve(api);
        else reject(new Error('turnstile_missing'));
      });
      s.addEventListener('error', () => reject(new Error('turnstile_load_failed')));
      doc.head.append(s);
    }).catch((e: unknown) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}

/** 测试用：把“已经在加载”的状态清掉 */
export function resetTurnstileLoaderForTest(): void {
  loading = null;
}

export interface TurnstileWidget {
  reset(): void;
  remove(): void;
}

/** 在 el 里画一个 Turnstile 小窗；拿到令牌、令牌过期、出错分别回调 */
export async function mountTurnstile(
  el: HTMLElement,
  opts: Omit<TurnstileRenderOptions, 'sitekey'> & { sitekey?: string },
  doc: Document = document,
): Promise<TurnstileWidget> {
  const api = await loadTurnstile(doc);
  const id = api.render(el, { ...opts, sitekey: opts.sitekey ?? turnstileSiteKey() });
  return {
    reset: () => api.reset(id),
    remove: () => api.remove(id),
  };
}
