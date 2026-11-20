// 插图显示（B4 S3）：note_images 的路径 → 能放进 <img> 的 blob: 地址（签名取字节、地址表和头像共用一份，改善报告 11-20 二-4）
// • 签名取字节走 platform/view-fetch.ts（同一轮的路径攒成一批签名、签名在请求头、签名过期重签一次，头像同一份）→ URL.createObjectURL，按路径缓存
// • 取不到（not_found：行写上了、图没传上，页面关了的那种）报 missing，界面出“图片没传上”；取不到记一行运行日志（只记步骤和结果码，不记路径）
// • 本页刚传上的图直接用本机那一份（seedView），不再去服务器取
// • 失败的不缓存（下次挂上再试）；同一路径同时只取一次
// • blob: 地址表走 core/blob-urls.ts（头像同一份）：有上限（MAX_URLS，超了 revoke 最早的）；行软删、撤销、集合清空（退出、换账号、被移除）时
//   revoke 掉不再用的（安全审建议 4：exe 上“退出没完成”停在原页时，旧账号的图也不留在内存里）。整页那一份订阅 note_images 集合自己清
// 纯 TS：不准 import React（A1）
import { isLiveRow } from '../../../../shared/logic/live-row.ts';
import { createBlobUrls } from '../../../core/blob-urls.ts';
import { collection } from '../../../core/store.ts';
import type { FilesClient } from '../../../platform/files.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { createViewFetch } from '../../../platform/view-fetch.ts';
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

export function createImageView(deps?: ViewDeps) {
  const urls = createBlobUrls({ max: deps?.max ?? MAX_URLS, revoke: deps?.revoke });
  const fetchView = createViewFetch(deps);
  const objectUrl = deps?.objectUrl ?? ((b: Blob) => URL.createObjectURL(b));

  async function load(path: string): Promise<ViewResult> {
    const r = await fetchView(path);
    if (!r.ok) {
      rlog(`notes image-view ${r.why}`);
      return { ok: false, missing: r.missing };
    }
    const url = objectUrl(r.blob);
    urls.keep(path, url);
    return { ok: true, url };
  }

  return {
    /** 本页刚传上的：直接记下本机那一份的地址 */
    seed(path: string, url: string): void {
      urls.keep(path, url);
    },
    /** 只留 live 里的路径，别的 revoke 掉（行软删、撤销、集合清空） */
    prune(live: ReadonlySet<string>): void {
      urls.prune(live);
    },
    /** 已经有的地址（同步取，没有回 null） */
    peek: urls.peek,
    get(path: string): Promise<ViewResult> {
      const hit = urls.peek(path);
      return hit ? Promise.resolve({ ok: true, url: hit }) : urls.once(path, () => load(path));
    },
  };
}

export type ImageView = ReturnType<typeof createImageView>;

/** note_images 里还在用的路径（原图和缩略图）：没删、没撤销的行 */
export function livePaths(rows: readonly Record<string, unknown>[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (!isLiveRow(r) || typeof r['path'] !== 'string') continue;
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
