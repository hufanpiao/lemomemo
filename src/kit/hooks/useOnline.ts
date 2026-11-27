// 现在有没有网（navigator.onLine + online / offline 事件）：设置页导出按钮断网时不可点、附件区断网时“加附件”变灰
// 各功能共用这一份
// 只作界面提示：onLine 为 true 不代表真能连上，真连不上由请求本身报 offline
import { useSyncExternalStore } from 'react';
import { onlineNow } from '../../platform/online.ts';

function subscribe(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener('online', fn);
  window.addEventListener('offline', fn);
  return () => {
    window.removeEventListener('online', fn);
    window.removeEventListener('offline', fn);
  };
}

/** 当下有没有网（不订阅；出错提示选“没有网络”还是“连不上服务器”用）：platform/online.ts 那一份 */
export { onlineNow };

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, onlineNow, () => true);
}
