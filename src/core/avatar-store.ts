// 头像仓（架构 5.4 头像一段；R-117、R-384 整块评审第 1 条）：avatar_id → blob: 地址，纪念日头像、我的头像各建一份，只此一处管地址
// • 地址的生成、撤销都在这里：取到的、本机刚传的（seed）都经 keep 记下；live 里已经没有的 avatar_id（换了、去掉、删了、退出清空）
//   revoke 掉、Cache Storage 里删掉（只在这里删）；最多留 AVATAR_CACHE_MAX 个，先存的先 revoke
// • 取一张（load）：内存里有直接回；同一个 avatar_id 同时只取一次；先读 Cache Storage（core/avatar-cache.ts），读不到才等首屏画完、
//   动态加载 core/avatar-view.ts 签名取图（它带 platform/files 的 zod，不进首屏），取回来的字节由它存进 Cache Storage
// • 取不到不记，下次再 load 照样再取；取回来时这个 avatar_id 已经不在 live 里（取的时候换了头像）不留、不存（整块评审第 5 条）
// • 地址有增减就通知 subscribe 的订阅者（kit 的 useMeAvatar 跟着重画）
// • 不带 zod，本身也只按需加载（纪念日经 features/anniv/data/avatar-view.ts，我的头像经 core/me-avatar.ts）
import { createSignal } from '../../shared/core/signal.ts';
import { appPainted } from '../platform/root-paint.ts';
import { AVATAR_CACHE_MAX, dropCachedAvatar, readCachedAvatar, type AvatarCacheSpec } from './avatar-cache.ts';
import { createBlobUrls } from './blob-urls.ts';
import type * as ViewNs from './avatar-view.ts';

export interface AvatarStoreSpec<P extends unknown[]> extends AvatarCacheSpec {
  /** 对象路径（库里 files_authorize 认的拼法） */
  path(...a: P): string;
  /** 现在还在用的 avatar_id */
  live(): ReadonlySet<string>;
  /** live 可能变了时调 fn（仓第一次用到时订阅一次） */
  watch(fn: () => void): void;
}

export interface AvatarStore<P extends unknown[]> {
  path(...a: P): string;
  /** 已经有的地址（同步取） */
  peek(avatarId: string): string | null;
  /** 取一张：回 blob: 地址，取不到回 null */
  load(path: string): Promise<string | null>;
  /** 本机刚编码的那一张：马上记下地址，字节在后台存进 Cache Storage */
  seed(avatarId: string, blob: Blob): Promise<void>;
  /** 地址有增减时通知；返回退订 */
  subscribe(fn: () => void): () => void;
  /** 马上按 live 撤一次（live 变了、却没有通知的时候用：我的头像没传上，profile 没换） */
  prune(): void;
}

const idOfPath = (path: string): string => path.slice(path.lastIndexOf('/') + 1, -'.webp'.length);
const view = (): Promise<typeof ViewNs> => import('./avatar-view.ts');

export function createAvatarStore<P extends unknown[]>(s: AvatarStoreSpec<P>): AvatarStore<P> {
  const subs = createSignal();
  let watching = false;
  const ping = subs.emit;
  // avatar_id → blob: 地址：和随手记插图同一份地址表（core/blob-urls.ts；超上限 revoke 最早的，有增减就通知订阅者）
  const urls = createBlobUrls({ max: AVATAR_CACHE_MAX, onChange: ping });
  const keep = urls.keep;

  /** 不在 live 里的 avatar_id revoke、删缓存 */
  function prune(): void {
    for (const k of urls.prune(s.live())) dropCachedAvatar(s, k);
  }

  /** live 变了就 prune（订阅一次） */
  function watch(): void {
    if (watching) return;
    watching = true;
    s.watch(prune);
  }

  async function get(id: string, path: string): Promise<string | null> {
    const hit = await readCachedAvatar(s, id);
    let blob = hit;
    if (blob === null) {
      await appPainted();
      blob = await (await view()).fetchAvatar(s.tag, path);
    }
    if (blob === null || !s.live().has(id)) return null;
    keep(id, URL.createObjectURL(blob));
    const b = blob;
    if (hit === null) void view().then((v) => v.writeCachedAvatar(s, id, b, s.live()));
    return urls.peek(id);
  }

  return {
    path: s.path,
    peek: urls.peek,
    load: (path) => {
      watch();
      const id = idOfPath(path);
      const hit = urls.peek(id);
      return hit ? Promise.resolve(hit) : urls.once(id, () => get(id, path));
    },
    seed: (avatarId, blob) => {
      watch();
      keep(avatarId, URL.createObjectURL(blob));
      return view().then((v) => v.writeCachedAvatar(s, avatarId, blob, s.live()));
    },
    subscribe: (fn) => {
      watch();
      return subs.subscribe(fn);
    },
    prune,
  };
}
