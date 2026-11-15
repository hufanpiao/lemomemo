// 头像的取图和缓存（纪念日头像 B5 S16、我的头像 R-384 共用；架构 5.4 头像一段、R-117）：images 桶里的 webp → blob: 地址
// • createAvatarView 按参数生成一份（缓存名、键前缀、日志前缀、路径函数、“现在还在用哪些 avatar_id”）：纪念日在 features/anniv/data/avatar-view.ts
//   包一层薄的；我的头像（meAvatarView）就在这里，kit 的 useMeAvatar 和设置页共用
// • 经 platform/files.ts：同一轮要的路径攒成一批签名（一批最多 SIGN_BATCH_MAX），再逐个取字节（签名在请求头）、URL.createObjectURL
// • 按 avatar_id 缓存（换头像 avatar_id 就变，旧的自然不再用）；同一个 avatar_id 同时只取一次；取不到的不缓存，下次挂上再试
// • 取回来的字节另存进 Cache Storage（core/avatar-cache.ts）：重开 App 先读缓存，读到就不再签名取图；本机刚传的那一张也存
// • 本机刚编码、刚传的那一张直接记下（seed），不再去服务器取
// • live 里已经没有的 avatar_id（换了、去掉、删了、退出清空）revoke 掉、缓存里删掉；最多留 AVATAR_CACHE_MAX 个
// • 运行日志只记 `<tag> avatar-<步骤> <结果码>`，不记图片和 id
// 只按需动态 import（platform/files.ts 带 zod，不进首屏；纪念日经 hooks/useAnnivAvatar，我的头像经 kit/hooks/useMeAvatar 等首屏画完）
import { fetchBlob, sign, SIGN_BATCH_MAX, upload, type UploadResult } from '../platform/files.ts';
import { rlog } from '../platform/run-log-api.ts';
import { AVATAR_MIME } from '../platform/avatar-encode.ts';
import { avatarCacheKey, dropCachedAvatar, ME_AVATAR, meAvatarId, meAvatarPath, openAvatarCache, readCachedAvatar, type AvatarCacheSpec } from './avatar-cache.ts';
import { getBoot, subscribeProfile } from './boot.ts';

/** 最多留几张（内存里的地址、Cache Storage 里的字节都按这个数；先存的先删） */
export const AVATAR_CACHE_MAX = 200;

/** 存一张进 Cache Storage（存完再回）；超过 AVATAR_CACHE_MAX 张删最早的。失败只记日志 */
export async function writeCachedAvatar(s: AvatarCacheSpec, avatarId: string, blob: Blob): Promise<void> {
  try {
    const c = await openAvatarCache(s);
    if (!c) return;
    await c.put(avatarCacheKey(s, avatarId), new Response(blob, { headers: { 'content-type': blob.type || AVATAR_MIME } }));
    const ks = await c.keys();
    for (const k of ks.slice(0, Math.max(0, ks.length - AVATAR_CACHE_MAX))) await c.delete(k.url);
  } catch {
    rlog(`${s.tag} avatar-cache failed`);
  }
}

export interface AvatarViewSpec<P extends unknown[]> extends AvatarCacheSpec {
  /** 对象路径（库里 files_authorize 认的拼法） */
  path(...a: P): string;
  /** 现在还在用的 avatar_id */
  live(): ReadonlySet<string>;
  /** live 可能变了时调 fn（只订阅一次） */
  watch(fn: () => void): void;
}

export interface AvatarView<P extends unknown[]> {
  path(...a: P): string;
  /** 已经有的地址（同步取） */
  peek(avatarId: string): string | null;
  /** 本机刚编码的那一张：马上能显示，存进 Cache Storage 以后才回 */
  seed(avatarId: string, blob: Blob): Promise<void>;
  /** 取一张：回 blob: 地址，取不到回 null */
  load(path: string): Promise<string | null>;
}

const idOfPath = (path: string): string => path.slice(path.lastIndexOf('/') + 1, -'.webp'.length);

export function createAvatarView<P extends unknown[]>(s: AvatarViewSpec<P>): AvatarView<P> {
  const done = new Map<string, string>();
  const inflight = new Map<string, Promise<string | null>>();
  const batch: { path: string; resolve(url: string | null): void }[] = [];
  let watching = false;

  function keep(avatarId: string, url: string): void {
    const old = done.get(avatarId);
    if (old !== undefined && old !== url) URL.revokeObjectURL(old);
    done.delete(avatarId);
    done.set(avatarId, url);
    for (const [k, u] of done) {
      if (done.size <= AVATAR_CACHE_MAX) break;
      done.delete(k);
      URL.revokeObjectURL(u);
    }
  }

  /** live 变了：不在用的 avatar_id 撤掉（订阅一次） */
  function watch(): void {
    if (watching) return;
    watching = true;
    s.watch(() => {
      const live = s.live();
      for (const [k, u] of done) {
        if (live.has(k)) continue;
        done.delete(k);
        URL.revokeObjectURL(u);
        dropCachedAvatar(s, k);
      }
    });
  }

  async function flush(): Promise<void> {
    const items = batch.splice(0, SIGN_BATCH_MAX);
    if (batch.length) setTimeout(() => void flush(), 0);
    let signed: Awaited<ReturnType<typeof sign>>;
    try {
      signed = await sign(items.map((x) => ({ bucket: 'images' as const, path: x.path, purpose: 'view' as const })));
    } catch {
      rlog(`${s.tag} avatar-sign failed`);   // 整块评审第 6 条：取图失败记一行，只记步骤和结果码
      for (const x of items) x.resolve(null);
      return;
    }
    await Promise.all(
      items.map(async (x, i) => {
        const r = signed[i];
        try {
          if (!r?.ok || r.sig === null) {
            rlog(`${s.tag} avatar-sign ${r?.ok === false ? `${r.kind}:${r.code}` : 'no_sig'}`);
            return x.resolve(null);
          }
          const b = await fetchBlob({ url: r.url, sig: r.sig });
          if (!b.ok) {
            rlog(`${s.tag} avatar-fetch ${b.kind}:${b.code}`);
            return x.resolve(null);
          }
          const url = URL.createObjectURL(b.blob);
          keep(idOfPath(x.path), url);
          void writeCachedAvatar(s, idOfPath(x.path), b.blob);
          x.resolve(url);
        } catch {
          rlog(`${s.tag} avatar-fetch failed`);
          x.resolve(null);
        }
      }),
    );
  }

  return {
    path: s.path,
    peek: (avatarId) => done.get(avatarId) ?? null,
    seed: (avatarId, blob) => {
      watch();
      keep(avatarId, URL.createObjectURL(blob));
      return writeCachedAvatar(s, avatarId, blob);
    },
    load: (path) => {
      watch();
      const id = idOfPath(path);
      const hit = done.get(id);
      if (hit) return Promise.resolve(hit);
      const going = inflight.get(id);
      if (going) return going;
      const p = readCachedAvatar(s, id)
        .then((b) => {
          if (b === null) {
            return new Promise<string | null>((resolve) => {
              if (batch.length === 0) setTimeout(() => void flush(), 0);
              batch.push({ path, resolve });
            });
          }
          const url = URL.createObjectURL(b);
          keep(id, url);
          return url;
        })
        .finally(() => inflight.delete(id));
      inflight.set(id, p);
      return p;
    },
  };
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

/** 我的头像（R-384）：缓存 lemo-me-avatar；还在用的只有 profile 里那一个 */
export const meAvatarView: AvatarView<[userId: string, avatarId: string]> = createAvatarView({
  ...ME_AVATAR,
  path: meAvatarPath,
  live: () => {
    const id = meAvatarId(getBoot()?.profile);
    return new Set(id === null ? [] : [id]);
  },
  watch: (fn) => void subscribeProfile(fn),
});
