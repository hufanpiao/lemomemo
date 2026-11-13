// 取附件的字节、下载、交给微软的链接（架构 5.13 第 3、4 点；架构约定 9.7）
// • 预览：POST /files/v1/sign（purpose view，60 秒）→ fetchBlob（签名在请求头 X-Files-Sig）→ 核对 sha256 和行里一致，不一致不预览；
//   取到的字节只放在本页内存（最多 MEM_MAX 个、合计 ≤ MEM_BYTES，先进先出），离线时这次打开 App 后看过的还能接着看；不进 IndexedDB、Cache Storage
// • 下载：purpose download 带清理过的文件名 d → fetchBlob → blob 的 type 只取 DOC_TYPES 里这一类的白名单类型（绝不沿用响应的 Content-Type）
//   → platform/save-file.ts（iPhone 主屏幕版走 Web Share“存到文件”，别的 a[download]）。exe 的 save_attachment 属 B6-exe 线，这里不接
// • 微软：purpose ms（只给 .pptx），签名留在查询串，拼成 view.officeapps.live.com 的 embed 地址
// 签名链接一律拿到就用、不存。纯 TS：不准 import React（A1）
import { DOC_TYPES, type DocKind } from '../../../../shared/manifests/attachments.ts';
import { sanitizeFileName } from '../../../../shared/logic/files/file-name.ts';
import { fetchBlob, sign, type FileError } from '../../../platform/files.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { saveFile, type SaveOutcome } from '../../../platform/save-file.ts';
import { sha256Hex } from './file-prep.ts';

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
const mem = new Map<string, ArrayBuffer>();

const failOf = (e: FileError): OpenFail => {
  if (e.reason === 'not_checked') return 'not_ready';
  if (e.kind === 'retry') return typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'retry';
  return 'denied';
};

function remember(id: string, b: ArrayBuffer): void {
  mem.delete(id);
  mem.set(id, b);
  let total = [...mem.values()].reduce((n, x) => n + x.byteLength, 0);
  for (const [k, v] of mem) {
    if (mem.size <= MEM_MAX && total <= MEM_BYTES) break;
    mem.delete(k);
    total -= v.byteLength;
  }
}

/** 这次打开 App 后取过的（离线时界面据此判断还能不能看） */
export const inMemory = (id: string): boolean => mem.has(id);

/** 签一项、取字节；签名或取字节失败回原因 */
async function fetchSigned(f: FileRef, purpose: 'view' | 'download', d?: string): Promise<{ ok: true; blob: Blob } | { ok: false; why: OpenFail }> {
  const [link] = await sign([{ bucket: 'files', path: f.path, purpose, ...(d !== undefined ? { d } : {}) }]);
  if (!link || !link.ok || !link.sig) {
    const why = link && !link.ok ? failOf(link) : 'denied';
    rlog(`att ${purpose} sign ${why}`);
    return { ok: false, why };
  }
  const b = await fetchBlob({ url: link.url, sig: link.sig });
  if (!b.ok) {
    rlog(`att ${purpose} fetch ${b.kind} code=${b.code}`);
    return { ok: false, why: failOf(b) };
  }
  return { ok: true, blob: b.blob };
}

/** 用完一份交出去的副本（预览沙箱收走 ArrayBuffer 的所有权，缓存里留原件） */
export async function openBytes(f: FileRef): Promise<OpenResult> {
  const t0 = Date.now();
  const hit = mem.get(f.id);
  if (hit) {
    rlog(`att open mem kind=${f.kind}`);
    return { ok: true, bytes: hit.slice(0) };
  }
  const b = await fetchSigned(f, 'view');
  if (!b.ok) return b;
  const bytes = await b.blob.arrayBuffer();
  if ((await sha256Hex(new Uint8Array(bytes))) !== f.sha256) {
    rlog(`att open mismatch kind=${f.kind}`);
    return { ok: false, why: 'mismatch' };
  }
  remember(f.id, bytes);
  rlog(`att open ok kind=${f.kind} kb=${Math.round(bytes.byteLength / 1024)} ms=${Date.now() - t0}`);
  return { ok: true, bytes: bytes.slice(0) };
}

export type DownloadResult = { ok: true; outcome: SaveOutcome } | { ok: false; why: OpenFail };

export async function download(f: FileRef): Promise<DownloadResult> {
  const name = sanitizeFileName(f.name, f.kind);
  const type = DOC_TYPES[f.kind];
  const cached = mem.get(f.id);
  let blob: Blob;
  if (cached) blob = new Blob([cached], { type });
  else {
    const b = await fetchSigned(f, 'download', name);
    if (!b.ok) return b;
    // 不沿用响应的 Content-Type（架构 5.13 第 4 点 (a)）
    blob = new Blob([await b.blob.arrayBuffer()], { type });
  }
  try {
    const outcome = await saveFile(blob, name, type);
    rlog(`att download ${outcome} kind=${f.kind}`);
    return { ok: true, outcome };
  } catch {
    rlog('att download save_failed');
    return { ok: false, why: 'retry' };
  }
}

/** 微软在线预览的地址（只给 .pptx）；拿不到回 null */
export async function msViewerUrl(f: FileRef): Promise<string | null> {
  if (f.kind !== 'pptx') return null;
  const [link] = await sign([{ bucket: 'files', path: f.path, purpose: 'ms' }]);
  rlog(`att ms sign ${link?.ok ? 'ok' : 'failed'}`);
  if (!link || !link.ok) return null;
  return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(link.url)}`;
}

export function clearMemForTest(): void {
  mem.clear();
}
