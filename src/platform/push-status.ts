// 这次启动推送订阅、认领的结果（ensurePushSubscription 的返回值）：交给设置 › 提醒显示提示
// （endpoint_in_use、resubscribe_failed、not_supported 各有一句）。
// 只放内存，不落盘；main.tsx 启动认领完调 setPushOutcome，设置页重新认领后也调
import { createSignal } from '../../shared/core/signal.ts';
import type { EnsurePushOutcome } from './push-claim.ts';

let current: EnsurePushOutcome | null = null;
const listeners = createSignal();

export function setPushOutcome(o: EnsurePushOutcome | null): void {
  current = o;
  listeners.emit();
}

export function getPushOutcome(): EnsurePushOutcome | null {
  return current;
}

export const subscribePushOutcome = listeners.subscribe;
