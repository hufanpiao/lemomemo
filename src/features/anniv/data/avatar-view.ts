// 纪念日头像的取图和缓存（B5 S16；架构 5.4 头像一段、R-117）：images 桶 <user_id>/anniv/<anniv_id>/<avatar_id>.webp → blob: 地址
// • 经 platform/files.ts：同一轮要的路径攒成一批签名（一批最多 SIGN_BATCH_MAX），再逐个取字节（签名在请求头）、URL.createObjectURL
// • 按 avatar_id 缓存（换头像 avatar_id 就变，旧的自然不再用）；同一个 avatar_id 同时只取一次；取不到的不缓存，下次挂上再试
// • 本机刚编码、刚传的那一张直接记下（seedAvatar），不再去服务器取
// • 集合里已经没有这个 avatar_id 的（换了、去掉、删了、退出清空）revoke 掉；最多留 MAX_URLS 个
// 只由 hooks/useAnnivAvatar 按需动态 import（data/avatar.ts 静态引它，也只在编辑页按需加载）（platform/files.ts 带 zod，不进首屏，A1：纯 TS 不碰 React）
// 随手记插图的 createImageView（features/notes/data/image-view.ts）是同一个思路；功能之间不能互相 import（A27），这里只做头像用得到的那一小份
import { collection } from '../../../core/store.ts';
import { fetchBlob, sign, SIGN_BATCH_MAX } from '../../../platform/files.ts';
import { rlog } from '../../../platform/run-log-api.ts';

const MAX_URLS = 200;
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
    if (done.size <= MAX_URLS) break;
    done.delete(k);
    URL.revokeObjectURL(u);
  }
}

/** 集合变了：不在用的 avatar_id 撤掉（订阅一次） */
function watch(): void {
  if (watching) return;
  watching = true;
  const c = collection<{ id: string; avatar_id?: unknown; deleted_at?: unknown }>('anniversaries');
  c.subscribe(() => {
    const live = new Set(c.getSnapshot().flatMap((r) => (typeof r.avatar_id === 'string' && (r.deleted_at ?? null) === null ? [r.avatar_id] : [])));
    for (const [k, u] of done) {
      if (live.has(k)) continue;
      done.delete(k);
      URL.revokeObjectURL(u);
    }
  });
}

const idOfPath = (path: string): string => path.slice(path.lastIndexOf('/') + 1, -'.webp'.length);

async function flush(): Promise<void> {
  const items = batch.splice(0, SIGN_BATCH_MAX);
  if (batch.length) setTimeout(() => void flush(), 0);
  let signed: Awaited<ReturnType<typeof sign>>;
  try {
    signed = await sign(items.map((x) => ({ bucket: 'images' as const, path: x.path, purpose: 'view' as const })));
  } catch {
    rlog('anniv avatar-sign failed');   // 整块评审第 6 条：取图失败记一行，只记步骤和结果码
    for (const x of items) x.resolve(null);
    return;
  }
  await Promise.all(
    items.map(async (x, i) => {
      const s = signed[i];
      try {
        if (!s?.ok || s.sig === null) {
          rlog(`anniv avatar-sign ${s?.ok === false ? `${s.kind}:${s.code}` : 'no_sig'}`);
          return x.resolve(null);
        }
        const b = await fetchBlob({ url: s.url, sig: s.sig });
        if (!b.ok) {
          rlog(`anniv avatar-fetch ${b.kind}:${b.code}`);
          return x.resolve(null);
        }
        const url = URL.createObjectURL(b.blob);
        keep(idOfPath(x.path), url);
        x.resolve(url);
      } catch {
        rlog('anniv avatar-fetch failed');
        x.resolve(null);
      }
    }),
  );
}

/** 头像路径（库里 files_authorize 认的拼法） */
export const avatarPath = (userId: string, annivId: string, avatarId: string): string => `${userId}/anniv/${annivId}/${avatarId}.webp`;

/** 已经有的地址（同步取） */
export function peekAvatar(avatarId: string): string | null {
  return done.get(avatarId) ?? null;
}

/** 本机刚编码的那一张（编辑页传完以后列表、今天页直接用） */
export function seedAvatar(avatarId: string, blob: Blob): void {
  watch();
  keep(avatarId, URL.createObjectURL(blob));
}

/** 取一张：回 blob: 地址，取不到回 null */
export function loadAvatar(path: string): Promise<string | null> {
  watch();
  const id = idOfPath(path);
  const hit = done.get(id);
  if (hit) return Promise.resolve(hit);
  const going = inflight.get(id);
  if (going) return going;
  const p = new Promise<string | null>((resolve) => {
    if (batch.length === 0) setTimeout(() => void flush(), 0);
    batch.push({ path, resolve });
  }).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}
