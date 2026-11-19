// 首屏画完了没有（platform/root-paint.ts 的 afterAppPainted）：按需下载的部件等它为真才挂、才下载，不算进首屏预算（kit/components/QuietBoundary.tsx 的 Later，afterPaint）
// 模块级一份订阅（独立评审 11-18 二-3：原来今天页每一行的行尾标记各带一个 effect、各向 root-paint 登记一个回调）：
// 没画完时，订阅的从 0 个变成 1 个才向 root-paint 登记一次，画完时通知所有订阅的；画完以后谁来读都是 true
import { useSyncExternalStore } from 'react';
import { afterAppPainted, isAppPainted } from '../../platform/root-paint.ts';

const subs = new Set<() => void>();

const flush = (): void => {
  for (const f of [...subs]) f();
};

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  if (subs.size === 1 && !isAppPainted()) afterAppPainted(flush);
  return () => {
    subs.delete(cb);
  };
}

export function usePainted(): boolean {
  return useSyncExternalStore(subscribe, isAppPainted, isAppPainted);
}
