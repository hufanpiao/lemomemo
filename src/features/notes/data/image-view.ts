// 插图显示（B4 S3）：note_images 的路径 → 能放进 <img> 的 blob: 地址
// • 经 platform/files.ts：sign（用途 view，同一轮的路径攒成一批、一批最多 100）→ fetchBlob（签名在请求头）→ URL.createObjectURL，按路径缓存
// • 签名过期（resign）重签一次；取不到（not_found：行写上了、图没传上，页面关了的那种）报 missing，界面出“图片没传上”
// • 本页刚传上的图直接用本机那一份（seedView），不再去服务器取
// • 失败的不缓存（下次挂上再试）；同一路径同时只取一次
// • blob: 地址有上限（MAX_URLS，超了 revoke 最早的）；行软删、撤销、集合清空（退出、换账号、被移除）时 revoke 掉不再用的（安全审建议 4：
//   exe 上“退出没完成”停在原页时，旧账号的图也不留在内存里）。整页那一份订阅 note_images 集合自己清
// 纯 TS：不准 import React（A1）
import { collection } from '../../../core/store.ts';
import { fetchBlob as realFetchBlob, sign as realSign, type FilesClient } from '../../../platform/files.ts';
import { thumbPath } from './note-images.ts';

export type ViewResult = { ok: true; url: string } | { ok: false; missing: boolean };

export interface ViewDeps {
  sign: FilesClient['sign'];
  fetchBlob: FilesClient['fetchBlob'];
  objectUrl(b: Blob): string;
  revoke(url: string): void;
  /** 最多留多少个 blob: 地址（默认 MAX_URLS） */
  max?: number;
}

export const MAX_URLS = 120;

const realDeps: ViewDeps = { sign: realSign, fetchBlob: realFetchBlob, objectUrl: (b) => URL.createObjectURL(b), revoke: (u) => URL.revokeObjectURL(u) };

export function createImageView(deps: ViewDeps = realDeps) {
  // Map 按放进来的先后排：超上限时先 revoke 最早的
  const done = new Map<string, string>();
  const keep = (path: string, url: string): void => {
    const old = done.get(path);
    if (old !== undefined && old !== url) deps.revoke(old);
    done.delete(path);
    done.set(path, url);
    const max = deps.max ?? MAX_URLS;
    for (const [p, u] of done) {
      if (done.size <= max) break;
      done.delete(p);
      deps.revoke(u);
    }
  };
  const inflight = new Map<string, Promise<ViewResult>>();
  let batch: { path: string; resolve(r: ViewResult): void }[] = [];

  async function one(path: string, resign: boolean): Promise<ViewResult> {
    const [s] = await deps.sign([{ bucket: 'images', path, purpose: 'view' }]);
    return fetchSigned(path, s, resign);
  }

  async function fetchSigned(path: string, s: Awaited<ReturnType<ViewDeps['sign']>>[number] | undefined, resign: boolean): Promise<ViewResult> {
    if (!s) return { ok: false, missing: false };
    if (!s.ok) return { ok: false, missing: s.code === 'not_found' || s.reason === 'no_row' };
    if (s.sig === null) return { ok: false, missing: false };
    const b = await deps.fetchBlob({ url: s.url, sig: s.sig });
    if (b.ok) {
      const url = deps.objectUrl(b.blob);
      keep(path, url);
      return { ok: true, url };
    }
    if (b.kind === 'resign' && resign) return one(path, false);
    return { ok: false, missing: b.code === 'not_found' };
  }

  async function flush(): Promise<void> {
    const items = batch;
    batch = [];
    let signed: Awaited<ReturnType<ViewDeps['sign']>>;
    try {
      signed = await deps.sign(items.map((x) => ({ bucket: 'images' as const, path: x.path, purpose: 'view' as const })));
    } catch {
      for (const x of items) x.resolve({ ok: false, missing: false });
      return;
    }
    await Promise.all(
      items.map(async (x, i) => {
        try {
          x.resolve(await fetchSigned(x.path, signed[i], true));
        } catch {
          x.resolve({ ok: false, missing: false });
        }
      }),
    );
  }

  return {
    /** 本页刚传上的：直接记下本机那一份的地址 */
    seed(path: string, url: string): void {
      keep(path, url);
    },
    /** 只留 live 里的路径，别的 revoke 掉（行软删、撤销、集合清空） */
    prune(live: ReadonlySet<string>): void {
      for (const [p, u] of done) {
        if (live.has(p)) continue;
        done.delete(p);
        deps.revoke(u);
      }
    },
    /** 已经有的地址（同步取，没有回 null） */
    peek(path: string): string | null {
      return done.get(path) ?? null;
    },
    get(path: string): Promise<ViewResult> {
      const hit = done.get(path);
      if (hit) return Promise.resolve({ ok: true, url: hit });
      const going = inflight.get(path);
      if (going) return going;
      const p = new Promise<ViewResult>((resolve) => {
        if (batch.length === 0) setTimeout(() => void flush(), 0);
        batch.push({ path, resolve });
      }).finally(() => inflight.delete(path));
      inflight.set(path, p);
      return p;
    },
  };
}

export type ImageView = ReturnType<typeof createImageView>;

/** note_images 里还在用的路径（原图和缩略图）：没删、没撤销的行 */
export function livePaths(rows: readonly Record<string, unknown>[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r['deleted_at'] != null || r['undone'] === true || typeof r['path'] !== 'string') continue;
    out.add(r['path']);
    out.add(thumbPath(r['path']));
  }
  return out;
}

let shared: ImageView | null = null;
/** 整页共用一份（卡片、编辑器、抽屉看同一张图只取一次）；订阅 note_images，行没了就 revoke */
export function imageView(): ImageView {
  if (!shared) {
    const v = createImageView();
    const rows = collection<{ id: string }>('note_images');
    rows.subscribe(() => v.prune(livePaths(rows.getSnapshot())));
    shared = v;
  }
  return shared;
}
export function resetImageViewForTest(v: ImageView | null = null): void {
  shared = v;
}
