// 一组 blob: 地址的内存表只有这一份：头像仓（core/avatar-store.ts，按 avatar_id）和
// 随手记插图（features/notes/data/image-view.ts，按路径）共用
// • keep：同一个键换了新地址就 revoke 旧的；超过 max 个先 revoke 最早放进来的（Map 按放进来的先后排）
// • prune(live)：不在 live 里的全部 revoke（行删了、换了头像、退出或换账号清空集合时：旧账号的图不留在内存里），回被撤掉的键
// • once：同一个键同时只取一次（取完就忘，失败的下次照样再取）
// • onChange：地址有增减时调（头像仓据此通知订阅者重画）
// • 默认撤地址走 platform/blob-url.ts 的 revokeBlobUrl：那里记着“地址 → 原 Blob”（看图页存到相册用），撤地址时一起删
// 纯 TS，不进首屏也不带 zod
import { revokeBlobUrl } from '../platform/blob-url.ts';

export interface BlobUrls {
  peek(key: string): string | null;
  keep(key: string, url: string): void;
  prune(live: ReadonlySet<string>): string[];
  once<T>(key: string, run: () => Promise<T>): Promise<T>;
}

export interface BlobUrlsOptions {
  max: number;
  revoke?: ((url: string) => void) | undefined;
  onChange?: (() => void) | undefined;
}

export function createBlobUrls(o: BlobUrlsOptions): BlobUrls {
  const revoke = o.revoke ?? revokeBlobUrl;
  const done = new Map<string, string>();
  const inflight = new Map<string, Promise<unknown>>();
  return {
    peek: (key) => done.get(key) ?? null,
    keep(key, url) {
      const old = done.get(key);
      if (old !== undefined && old !== url) revoke(old);
      done.delete(key);
      done.set(key, url);
      for (const [k, u] of done) {
        if (done.size <= o.max) break;
        done.delete(k);
        revoke(u);
      }
      o.onChange?.();
    },
    prune(live) {
      const gone: string[] = [];
      for (const [k, u] of done) {
        if (live.has(k)) continue;
        done.delete(k);
        revoke(u);
        gone.push(k);
      }
      if (gone.length) o.onChange?.();
      return gone;
    },
    once<T>(key: string, run: () => Promise<T>): Promise<T> {
      const going = inflight.get(key);
      if (going) return going as Promise<T>;
      const p = run().finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
  };
}
