// 头像的网络那一半（纪念日头像、我的头像共用）：签名取图、写 Cache Storage、上传
// • fetchAvatar：经 platform/view-fetch.ts（和随手记插图同一份）：同一轮要的路径攒成一批签名，再逐个取字节（签名在请求头），
//   签名过期重签一次；回 Blob，取不到回 null。地址（blob:）不在这里生成，归头像仓 core/avatar-store.ts 管
// • writeCachedAvatar：字节存进 Cache Storage；顺手把 live 里已经没有的（这一次打开没见过的旧头像也算）删掉，最多留 AVATAR_CACHE_MAX 张
// • putAvatar：传一张，可重试的错误退避再试两次
// • 运行日志只记 `<tag> avatar-<步骤> <结果码>`，不记图片和 id
// 只由头像仓按需动态 import，或换头像的流程（设置、纪念日编辑页，本来就按需加载）静态引：platform/files.ts 带 zod，不进首屏
import { upload, type UploadResult } from '../platform/files.ts';
import { rlog } from '../platform/run-log-api.ts';
import { createViewFetch } from '../platform/view-fetch.ts';
import { AVATAR_MIME } from '../platform/avatar-encode.ts';
import { AVATAR_CACHE_MAX, avatarCacheKey, openAvatarCache, type AvatarCacheSpec } from './avatar-cache.ts';

/**
 * 存一张进 Cache Storage（存完再回）：同时删掉 live 里没有的（这一张除外：我的头像传完、交给 boot 之前 live 里还没有它），
 * 再超过 AVATAR_CACHE_MAX 张删最早的。失败只记日志
 */
export async function writeCachedAvatar(s: AvatarCacheSpec, avatarId: string, blob: Blob, live: ReadonlySet<string>): Promise<void> {
  try {
    const c = await openAvatarCache(s);
    if (!c) return;
    const mine = avatarCacheKey(s, avatarId);
    await c.put(mine, new Response(blob, { headers: { 'content-type': blob.type || AVATAR_MIME } }));
    const head = avatarCacheKey(s, '');
    const ks = (await c.keys()).map((k) => k.url);
    const keep = ks.filter((k) => k === mine || live.has(k.slice(head.length)));
    const drop = [...ks.filter((k) => !keep.includes(k)), ...keep.slice(0, Math.max(0, keep.length - AVATAR_CACHE_MAX))];
    for (const k of drop) await c.delete(k);
  } catch {
    rlog(`${s.tag} avatar-cache failed`);
  }
}

/** 签名取字节和随手记插图同一份（platform/view-fetch.ts）；纪念日、我的头像两份仓共用这一个，同一轮的攒成一批签名 */
const viewFetch = createViewFetch();

/** 签名取一张的字节（签名过期重签一次）；取不到回 null，记一行 `<tag> avatar-<步骤> <结果码>`（tag 只用来记日志） */
export async function fetchAvatar(tag: string, path: string): Promise<Blob | null> {
  const r = await viewFetch(path);
  if (r.ok) return r.blob;
  rlog(`${tag} avatar-${r.why}`);
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 传一张头像：可重试的错误退避（1 秒、2 秒）再试两次，回最后一次的结果（纪念日、我的头像共用） */
export async function putAvatar(path: string, blob: Blob): Promise<UploadResult> {
  for (let i = 0; ; i++) {
    const r = await upload('images', path, blob, AVATAR_MIME);
    if (r.ok || r.kind !== 'retry' || i >= 2) return r;
    await sleep(1000 * 2 ** i);
  }
}
