// 联网和前后台（架构 4.2“发送的触发时机”、4.3）：上线、切到前台、切到后台。core/sync 经这里听，不自己碰 window、document
// 浏览器环境以外（测试、SSR）一律当作“在前台、在线”，监听什么也不做
export interface Lifecycle {
  /** 恢复网络（window 的 online 事件）；返回取消函数 */
  onOnline(fn: () => void): () => void;
  /** 切到前台（true）/ 后台（false）（document 的 visibilitychange）；返回取消函数 */
  onVisibility(fn: (visible: boolean) => void): () => void;
  isVisible(): boolean;
  isOnline(): boolean;
}

const hasWindow = (): boolean => typeof window !== 'undefined' && typeof document !== 'undefined';

export const browserLifecycle: Lifecycle = {
  onOnline(fn) {
    if (!hasWindow()) return () => undefined;
    const h = (): void => fn();
    window.addEventListener('online', h);
    return () => window.removeEventListener('online', h);
  },
  onVisibility(fn) {
    if (!hasWindow()) return () => undefined;
    const h = (): void => fn(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  },
  isVisible: () => !hasWindow() || document.visibilityState === 'visible',
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
};

/**
 * 用户操作（pointerdown、keydown；捕获阶段、passive）：report_tz 的“有用户操作时”（架构 4.6、4.3b）。返回取消函数
 */
export function onUserActivity(fn: () => void): () => void {
  if (!hasWindow()) return () => undefined;
  const h = (): void => fn();
  const o: AddEventListenerOptions = { capture: true, passive: true };
  window.addEventListener('pointerdown', h, o);
  window.addEventListener('keydown', h, o);
  return () => {
    window.removeEventListener('pointerdown', h, o);
    window.removeEventListener('keydown', h, o);
  };
}
