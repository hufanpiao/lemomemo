// 注册 Service Worker（架构 8.1、16.1）：sw.js 放在 /app/，scope 只管 /app/，首页不受影响
// navigator.serviceWorker 只准出现在 platform（A13）
export const SW_URL = '/app/sw.js';
export const SW_SCOPE = '/app/';

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  } catch {
    // 注册失败不影响使用（只是没有离线）；B1 接上日志后记错误码
    return null;
  }
}
