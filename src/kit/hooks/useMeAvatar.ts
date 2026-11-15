// 我的头像的 blob: 地址（R-384）：今天、待办、日历、随手记四页右上角的 MeLink、设置首页账号一行、电脑版侧栏的设置入口都经 MeAvatar 用这一份
// • 读启动时缓存的 profiles 本人那一行的 avatar_id（core/boot 的 profile）；profile 变了（applyFreshConfig：联网刷新、设置里换了头像）跟着换
// • 先查 Cache Storage（core/avatar-cache.ts，只碰缓存、不带 zod）；查不到再动态加载 core/avatar-view.ts 签名取图——
//   而且等首屏画完（platform/root-paint 的 appPainted）才加载：今天页在首屏，不能把 platform/files（zod）带进首屏闭包
// • 没头像、还在取、取不到都回 null（MeAvatar 画名字首字，没名字画通用人像）
// • 几处同时挂也只有一份地址（模块里一个小仓）。缓存读出来的 blob: 地址不 revoke：一次打开最多换几次头像、每张 ≤ 100 KB，
//   为它在首屏多带一套“地址归谁管”的判断不划算（首屏额度，R-384）；网络取的归 core/avatar-view 管（它按 live 集合 revoke）
// • 运行日志只记 `me avatar-<步骤> <结果码>`，不记图片和 id
import { useSyncExternalStore } from 'react';
import { dropCachedAvatar, ME_AVATAR, meAvatarId, meAvatarPath, readCachedAvatar } from '../../core/avatar-cache.ts';
import { getBoot, subscribeProfile } from '../../core/boot.ts';
import { appPainted } from '../../platform/root-paint.ts';
import { rlog } from '../../platform/run-log-api.ts';

let want: string | null = null;
let url: string | null = null;
const subs = new Set<() => void>();
let offProfile: (() => void) | null = null;

function set(next: string | null): void {
  url = next;
  subs.forEach((fn) => fn());
}

async function resolve(uid: string, id: string): Promise<string | null> {
  const b = await readCachedAvatar(ME_AVATAR, id);
  if (b) return URL.createObjectURL(b);
  await appPainted();
  return (await import('../../core/avatar-view.ts')).meAvatarView.load(meAvatarPath(uid, id));
}

/** profile 里的 avatar_id 变了才重新取 */
function sync(): void {
  const boot = getBoot();
  const id = meAvatarId(boot?.profile);
  if (id === want) return;
  if (want !== null) dropCachedAvatar(ME_AVATAR, want);   // 换了、去掉了：旧的那张不再用
  want = id;
  set(null);
  const uid = boot?.userId ?? null;
  if (id === null || uid === null) return;
  resolve(uid, id)
    .then((u) => want === id && set(u))
    .catch(() => rlog('me avatar-view failed'));
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  if (offProfile === null) {
    offProfile = subscribeProfile(sync);
    sync();
  }
  return () => void subs.delete(fn);
}

const snapshot = (): string | null => url;

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
  offProfile?.();
  offProfile = null;
  want = null;
  url = null;
  subs.clear();
}
