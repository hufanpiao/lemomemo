// 现在有没有网（navigator.onLine + online / offline 事件）：导出按钮断网时不可点（R-256 ②）
// 只作界面提示：onLine 为 true 不代表真能连上，真连不上由请求本身报 offline
import { useSyncExternalStore } from 'react';

function subscribe(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener('online', fn);
  window.addEventListener('offline', fn);
  return () => {
    window.removeEventListener('online', fn);
    window.removeEventListener('offline', fn);
  };
}

const read = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false;

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, read, () => true);
}
