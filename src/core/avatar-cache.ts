// 头像字节的本机缓存（Cache Storage；架构 5.4 头像一段，整块评审第 16 条）：纪念日头像、我的头像（R-384）共用这一份
// • 一种头像一个缓存（名字由调用方给：lemo-anniv-avatar、lemo-me-avatar），键是按 avatar_id 拼的本站地址（不用带签名的链接）
// • 打不开（隐私模式等）一律当没缓存，调用方照常走网络；退出登录、换账号时 platform/session.ts 的 clearCacheStorage 一起删（名字不以预缓存前缀开头）
// • 只碰 Cache Storage，不带 platform/files（zod）：头像仓 core/avatar-store.ts 先读这里，读不到才加载 core/avatar-view.ts 签名取图；
//   写（取图、上传以后才有）在 core/avatar-view.ts

/** 最多留几张（仓里的 blob: 地址、Cache Storage 里的字节都按这个数；先存的先删） */
export const AVATAR_CACHE_MAX = 200;

export interface AvatarCacheSpec {
  /** Cache Storage 的名字 */
  cache: string;
  /** 键的路径段：`${location.origin}/${keyPrefix}/${avatar_id}` */
  keyPrefix: string;
  /** 运行日志前缀（anniv / me）：只记 `<tag> avatar-cache <结果码>` */
  tag: string;
}

/** 缓存键：本站地址（不用带签名的链接） */
export const avatarCacheKey = (s: AvatarCacheSpec, avatarId: string): string => `${location.origin}/${s.keyPrefix}/${avatarId}`;
/** 打开这一种头像的缓存；打不开（隐私模式等）回 null */
export const openAvatarCache = (s: AvatarCacheSpec): Promise<Cache | null> => (typeof caches === 'undefined' ? Promise.resolve(null) : caches.open(s.cache).catch(() => null));

/** 读一张；没有、打不开回 null */
export async function readCachedAvatar(s: AvatarCacheSpec, avatarId: string): Promise<Blob | null> {
  try {
    const r = await (await openAvatarCache(s))?.match(avatarCacheKey(s, avatarId));
    return r ? await r.blob() : null;
  } catch {
    return null;
  }
}

/** 删一张（不再用了） */
export function dropCachedAvatar(s: AvatarCacheSpec, avatarId: string): void {
  void openAvatarCache(s)
    .then((c) => c?.delete(avatarCacheKey(s, avatarId)))
    .catch(() => undefined);
}
