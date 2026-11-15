// 头像的网络那一半（纪念日头像 B5 S16、我的头像 R-384 共用；架构 5.4 头像一段、R-117）：签名取图、写 Cache Storage、上传
// • fetchAvatar：经 platform/files.ts，同一轮要的路径攒成一批签名（一批最多 SIGN_BATCH_MAX），再逐个取字节（签名在请求头）；
//   回 Blob，取不到回 null。地址（blob:）不在这里生成，归头像仓 core/avatar-store.ts 管
// • writeCachedAvatar：字节存进 Cache Storage；顺手把 live 里已经没有的（这一次打开没见过的旧头像也算，整块评审第 10 条）删掉，最多留 AVATAR_CACHE_MAX 张
// • putAvatar：传一张，可重试的错误退避再试两次
// • 运行日志只记 `<tag> avatar-<步骤> <结果码>`，不记图片和 id
// 只由头像仓按需动态 import，或换头像的流程（设置、纪念日编辑页，本来就按需加载）静态引：platform/files.ts 带 zod，不进首屏
import { fetchBlob, sign, SIGN_BATCH_MAX, upload, type UploadResult } from '../platform/files.ts';
import { rlog } from '../platform/run-log-api.ts';
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

const batch: { tag: string; path: string; resolve(b: Blob | null): void }[] = [];

async function flush(): Promise<void> {
  const items = batch.splice(0, SIGN_BATCH_MAX);
  if (batch.length) setTimeout(() => void flush(), 0);
  let signed: Awaited<ReturnType<typeof sign>>;
  try {
    signed = await sign(items.map((x) => ({ bucket: 'images' as const, path: x.path, purpose: 'view' as const })));
  } catch {
    for (const x of items) {
      rlog(`${x.tag} avatar-sign failed`);   // 整块评审第 6 条：取图失败记一行，只记步骤和结果码
      x.resolve(null);
    }
    return;
  }
  await Promise.all(
    items.map(async (x, i) => {
      const r = signed[i];
      try {
        if (!r?.ok || r.sig === null) {
          rlog(`${x.tag} avatar-sign ${r?.ok === false ? `${r.kind}:${r.code}` : 'no_sig'}`);
          return x.resolve(null);
        }
        const b = await fetchBlob({ url: r.url, sig: r.sig });
        if (!b.ok) {
          rlog(`${x.tag} avatar-fetch ${b.kind}:${b.code}`);
          return x.resolve(null);
        }
        x.resolve(b.blob);
      } catch {
        rlog(`${x.tag} avatar-fetch failed`);
        x.resolve(null);
      }
    }),
  );
}

/** 签名取一张的字节；取不到回 null（tag 只用来记日志） */
export function fetchAvatar(tag: string, path: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (batch.length === 0) setTimeout(() => void flush(), 0);
    batch.push({ tag, path, resolve });
  });
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
