// 这次启动推送订阅、认领的结果（B2 任务单 FA-4；FA-1 的 ensurePushSubscription 返回值）：交给设置 › 提醒显示
// • endpoint_in_use：顶部提示“移除它”（0.29 续第 105 条，TC-B2-71）
// • resubscribe_failed：提示“推送需要重新打开，点一下”（R-282 ③）
// • not_supported：提示“这个浏览器的推送服务暂不支持”
// 只放内存，不落盘；app/main.tsx 启动认领完调 setPushOutcome，设置页在点按里重新认领后也调
import type { EnsurePushOutcome } from './push-claim.ts';

let current: EnsurePushOutcome | null = null;
const listeners = new Set<() => void>();

export function setPushOutcome(o: EnsurePushOutcome | null): void {
  current = o;
  for (const l of [...listeners]) l();
}

export function getPushOutcome(): EnsurePushOutcome | null {
  return current;
}

export function subscribePushOutcome(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
