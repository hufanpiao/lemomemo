// 我的头像的 blob: 地址（R-384）：今天、待办、日历、随手记四页右上角的 MeLink、设置首页账号一行、电脑版侧栏的设置入口都经 MeAvatar 用这一份
// • 地址只归头像仓管（core/me-avatar.ts 的 meAvatarStore，做法在 core/avatar-store.ts；R-384 整块评审第 1 条）：这里只订阅它，
//   读 profile 里的 avatar_id（core/cache 的 meAvatarId）去仓里查；仓里还没有就叫仓去取（先读 Cache Storage，读不到再签名取图）
// • 仓等首屏画完（platform/root-paint 的 appPainted）才动态加载：今天页在首屏，仓和取图都不进首屏闭包
// • 取不到不记：下一次通知（profile 变了、仓里地址有增减）照样再取（整块评审第 4 条）
// • 没头像、还在取、取不到都回 null（MeAvatar 画名字首字，没名字画通用人像）
import { useSyncExternalStore } from 'react';
import { createSignal } from '../../../shared/core/signal.ts';
import type { AvatarStore } from '../../core/avatar-store.ts';
import { getBoot, subscribeProfile } from '../../core/boot.ts';
import { meAvatarId } from '../../core/cache.ts';
import { appPainted } from '../../platform/root-paint.ts';
import { rlog } from '../../platform/run-log-api.ts';

let store: AvatarStore<[string, string]> | null = null;
let started = false;
const offs: (() => void)[] = [];
const subs = createSignal();

/** 现在的头像仓里还没有就去取 */
function want(): void {
  const boot = getBoot();
  const id = meAvatarId(boot?.profile);
  const uid = boot?.userId ?? null;
  if (store === null || id === null || uid === null || store.peek(id) !== null) return;
  store.load(store.path(uid, id)).catch(() => rlog('me avatar-view failed'));
}

function ping(): void {
  want();
  subs.emit();
}

function subscribe(fn: () => void): () => void {
  const off = subs.subscribe(fn);
  if (!started) {
    started = true;
    appPainted()
      .then(() => import('../../core/me-avatar.ts'))
      .then((m) => {
        store = m.meAvatarStore;
        offs.push(store.subscribe(ping), subscribeProfile(ping));
        ping();
      })
      .catch(() => rlog('me avatar-store failed'));
  }
  return off;
}

const snapshot = (): string | null => {
  const id = meAvatarId(getBoot()?.profile);
  return id === null || store === null ? null : store.peek(id);
};

/** 我的头像的 blob: 地址；没有（没头像、还在取、取不到）回 null */
export function useMeAvatar(): string | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

const idNow = (): string | null => meAvatarId(getBoot()?.profile);

/** 现在有没有设头像（profile 里的 avatar_id；设置 › 账号决定显不显示“去掉头像”） */
export function useHasMeAvatar(): boolean {
  return useSyncExternalStore(subscribeProfile, idNow, idNow) !== null;
}

/** 测试用：清掉模块里的状态 */
export function resetMeAvatarForTest(): void {
  for (const off of offs.splice(0)) off();
  store = null;
  started = false;
  subs.clear();
}
