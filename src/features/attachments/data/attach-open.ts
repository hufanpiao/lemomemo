// 取附件的字节、下载、交给微软的链接（架构 5.13 第 3、4 点；架构约定 9.7）
// • 预览：POST /files/v1/sign（purpose view，60 秒）→ fetchBlob（签名在请求头 X-Files-Sig）→ 核对 sha256 和行里一致，不一致不预览；
//   取到的字节只放在本页内存（最多 MEM_MAX 个、合计 ≤ MEM_BYTES，先进先出），离线时这次打开 App 后看过的还能接着看；不进 IndexedDB、Cache Storage
// • 下载：purpose download 带清理过的文件名 d → fetchBlob → blob 的 type 只取 DOC_TYPES 里这一类的白名单类型（绝不沿用响应的 Content-Type）
//   → platform/save-file.ts（iPhone 主屏幕版走 Web Share“存到文件”，别的 a[download]）。exe 的 save_attachment 属 B6-exe 线，这里不接
// • 微软：purpose ms（只给 .pptx），签名留在查询串，拼成 view.officeapps.live.com 的 embed 地址
// • 用其他 App 打开：先照预览取字节（核 sha256、进本页内存），再交给系统分享面板（platform/save-file.ts 的 shareFile）
// • 缩略图：电脑上列表显示首页缩略图，签 view 取 <id>.t.webp（只给 has_thumb 的行）
// 签名链接一律拿到就用、不存。纯 TS：不准 import React（A1）
import { DOC_TYPES, type DocKind } from '../../../../shared/manifests/attachments.ts';
import { sanitizeFileName } from '../../../../shared/logic/files/file-name.ts';
import { noteFileThumbPath } from '../../../../shared/logic/files/media-path.ts';
import { fetchBlob, sign, type FileError } from '../../../platform/files.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { saveFile, shareFile, type SaveOutcome } from '../../../platform/save-file.ts';
import { sha256Hex } from '../../../platform/sha256.ts';

export interface FileRef {
  id: string;
  path: string;
  kind: DocKind;
  name: string;
  sha256: string;
}

export type OpenFail = 'offline' | 'not_ready' | 'mismatch' | 'denied' | 'retry';
export type OpenResult = { ok: true; bytes: ArrayBuffer } | { ok: false; why: OpenFail };

export const MEM_MAX = 6;
export const MEM_BYTES = 40 * 1_048_576;

/** 本页内存里的明文字节（最多 MEM_MAX 个、合计 ≤ MEM_BYTES，先进先出）：普通附件一份（整个页面），隐私记每个附件区一份（上锁、离开就丢） */
export function memCache() {
  const m = new Map<string, ArrayBuffer>();
  return {
    get: (id: string): ArrayBuffer | undefined => m.get(id),
    has: (id: string): boolean => m.has(id),
    clear: (): void => m.clear(),
    set(id: string, b: ArrayBuffer): void {
      m.delete(id);
      m.set(id, b);
      let total = [...m.values()].reduce((n, x) => n + x.byteLength, 0);
      for (const [k, v] of m) {
        if (m.size <= MEM_MAX && total <= MEM_BYTES) break;
        m.delete(k);
        total -= v.byteLength;
      }
    },
  };
}
const mem = memCache();

const failOf = (e: FileError): OpenFail => {
  if (e.reason === 'not_checked') return 'not_ready';
  if (e.kind === 'retry') return typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'retry';
  return 'denied';
};

/** 这次打开 App 后取过的（离线时界面据此判断还能不能看） */
export const inMemory = (id: string): boolean => mem.has(id);

/** 签一项、取字节；签名或取字节失败回原因 */
async function fetchSigned(f: FileRef, purpose: 'view' | 'download', d?: string): Promise<{ ok: true; blob: Blob } | { ok: false; why: OpenFail }> {
  const [link] = await sign([{ bucket: 'files', path: f.path, purpose, ...(d !== undefined ? { d } : {}) }]);
  if (!link || !link.ok || !link.sig) {
    const why = link && !link.ok ? failOf(link) : 'denied';
    rlog(`att ${purpose} sign ${why} code=${link && !link.ok ? link.code : 'no_sig'}`);
    return { ok: false, why };
  }
  const b = await fetchBlob({ url: link.url, sig: link.sig });
  if (!b.ok) {
    rlog(`att ${purpose} fetch ${b.kind} code=${b.code}`);
    return { ok: false, why: failOf(b) };
  }
  return { ok: true, blob: b.blob };
}

/** 取到的字节核 sha256（和行上记的对不上就不交出去），对上了进缓存；预览、下载同一条规矩（评审 13） */
async function fetchVerified(f: FileRef, purpose: 'view' | 'download', d?: string): Promise<OpenResult> {
  const t0 = Date.now();
  const b = await fetchSigned(f, purpose, d);
  if (!b.ok) return b;
  const bytes = await b.blob.arrayBuffer();
  if ((await sha256Hex(new Uint8Array(bytes))) !== f.sha256) {
    rlog(`att ${purpose} mismatch kind=${f.kind}`);
    return { ok: false, why: 'mismatch' };
  }
  mem.set(f.id, bytes);
  rlog(`att ${purpose} ok kind=${f.kind} kb=${Math.round(bytes.byteLength / 1024)} ms=${Date.now() - t0}`);
  return { ok: true, bytes };
}

/** 交出缓存里的那一份（不复制，整块评审第 12 条）：只许读；要转移进预览沙箱的，转移前自己 slice 一份（SandboxFrame） */
export async function openBytes(f: FileRef): Promise<OpenResult> {
  const hit = mem.get(f.id);
  if (hit) {
    rlog(`att open mem kind=${f.kind}`);
    return { ok: true, bytes: hit };
  }
  return fetchVerified(f, 'view');
}

export type DownloadResult = { ok: true; outcome: SaveOutcome } | { ok: false; why: OpenFail };

export async function download(f: FileRef): Promise<DownloadResult> {
  const b = mem.get(f.id) ?? (await fetchVerified(f, 'download', sanitizeFileName(f.name, f.kind)));
  if (b instanceof ArrayBuffer) return saveBytes(b, f);
  return b.ok ? saveBytes(b.bytes, f) : b;
}

/** 已经拿到明文字节：存到本机（普通、隐私记共用）。类型只取 DOC_TYPES 里这一类的，不沿用响应的 Content-Type（架构 5.13 第 4 点 (a)） */
export async function saveBytes(bytes: ArrayBuffer, f: Pick<FileRef, 'kind' | 'name'>, revokeMs?: number): Promise<DownloadResult> {
  const name = sanitizeFileName(f.name, f.kind);
  const type = DOC_TYPES[f.kind];
  try {
    const outcome = await saveFile(new Blob([bytes], { type }), name, type, undefined, revokeMs);
    rlog(`att download ${outcome} kind=${f.kind}`);
    return { ok: true, outcome };
  } catch {
    rlog('att download save_failed');
    return { ok: false, why: 'retry' };
  }
}

export type ShareResult = { ok: true; outcome: SaveOutcome | 'unsupported' } | { ok: false; why: OpenFail };

/** 已经拿到明文字节：交给系统分享面板（普通、隐私记共用；类型只取白名单，文件名清理过） */
export async function shareBytes(bytes: ArrayBuffer, f: Pick<FileRef, 'kind' | 'name'>): Promise<ShareResult> {
  const type = DOC_TYPES[f.kind];
  const outcome = await shareFile(new Blob([bytes], { type }), sanitizeFileName(f.name, f.kind), type);
  rlog(`att share ${outcome} kind=${f.kind}`);
  return { ok: true, outcome };
}

/** 用其他 App 打开（普通附件） */
export async function share(f: FileRef): Promise<ShareResult> {
  const r = await openBytes(f);
  return r.ok ? shareBytes(r.bytes, f) : r;
}

/** 首页缩略图（webp）；没有、取不到回 null（列表照常显示类型标记） */
export async function thumbBlob(f: FileRef & { noteId: string }): Promise<Blob | null> {
  const uid = f.path.split('/')[0] ?? '';
  const [link] = await sign([{ bucket: 'files', path: noteFileThumbPath(uid, f.noteId, f.id), purpose: 'view' }]);
  if (!link || !link.ok || !link.sig) return null;
  const b = await fetchBlob({ url: link.url, sig: link.sig });
  if (!b.ok) rlog(`att thumb fetch ${b.kind}`);
  return b.ok ? b.blob : null;
}

/** 微软在线预览的地址（只给 .pptx）；拿不到回 null */
export async function msViewerUrl(f: FileRef): Promise<string | null> {
  if (f.kind !== 'pptx') return null;
  const [link] = await sign([{ bucket: 'files', path: f.path, purpose: 'ms' }]);
  rlog(`att ms sign ${link?.ok ? 'ok' : 'failed'}`);
  if (!link || !link.ok) return null;
  return msEmbedOf(link.url);
}

/** 微软 embed 地址（普通附件的 ms 签名链接、隐私记的 vault-preview 签名链接都拼成这样） */
export const msEmbedOf = (src: string): string => `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(src)}`;

export function clearMemForTest(): void {
  mem.clear();
}
