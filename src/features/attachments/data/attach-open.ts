// 取附件的字节、下载、交给微软的链接
// • 预览：POST /files/v1/sign（purpose view，60 秒）→ fetchBlob（签名在请求头 X-Files-Sig）→ 核对 sha256 和行里一致，不一致不预览；
//   取到的字节只放在本页内存（最多 MEM_MAX 个、合计 ≤ MEM_BYTES，先进先出），离线时这次打开 App 后看过的还能接着看；不进 IndexedDB、Cache Storage
// • 下载：本页内存里有就直接存；没有就 purpose download 带清理过的文件名 d → fetchBlob → 同预览核 sha256、进本页内存 →
//   blob 的 type 只取 DOC_TYPES 里这一类的白名单类型（绝不沿用响应的 Content-Type）
//   → platform/save-file.ts（iPhone 主屏幕版走 Web Share“存到文件”，别的 a[download]）。
//   exe 里改走 platform/desktop-attachment.ts：只签 download 链接，交给 Rust 的 save_attachment 下载、核 sha256 和文件头、弹“另存为”、
//   写盘带来源标记（不经本页内存，离线时存不了）；隐私记的明文字节照旧走 saveBytes
// • 微软：purpose ms（只给 .pptx），签名留在查询串，拼成 view.officeapps.live.com 的 embed 地址
// • 用其他 App 打开：先照预览取字节（核 sha256、进本页内存），再交给系统分享面板（platform/save-file.ts 的 shareFile）
// • 缩略图：电脑上列表显示首页缩略图，签 view 取 <id>.t.webp（只给 has_thumb 的行）
// 签名链接一律拿到就用、不存。纯 TS：不准 import React
import { DOC_TYPES, type DocKind } from '../../../../shared/manifests/attachments.ts';
import { sanitizeFileName } from '../../../../shared/logic/files/file-name.ts';
import { noteFileThumbPath } from '../../../../shared/logic/files/media-path.ts';
import { exeByteSaver, exeSaver } from '../../../platform/desktop-attachment.ts';
import { fetchBlob, sign, type FileError } from '../../../platform/files.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { saveFile, shareFile, type SaveOptions, type SaveOutcome } from '../../../platform/save-file.ts';
import { sha256Hex } from '../../../platform/sha256.ts';
import { onlineNow } from '../../../platform/online.ts';

export interface FileRef {
  id: string;
  path: string;
  kind: DocKind;
  name: string;
  sha256: string;
}

/** 后四种只有 exe 另存会回（exeFailOf）：存的位置不行、正在存另一个、文件太大、不可重试的失败 */
export type OpenFail = 'offline' | 'not_ready' | 'mismatch' | 'denied' | 'retry' | 'save_location' | 'save_busy' | 'too_large' | 'save_failed';
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
  if (e.kind === 'retry') return onlineNow() ? 'retry' : 'offline';
  return 'denied';
};

/** 这次打开 App 后取过的（离线时界面据此判断还能不能看） */
export const inMemory = (id: string): boolean => mem.has(id);

/** 签一项（view、download 回 url + 请求头签名）；签名失败回原因 */
async function signLink(f: FileRef, purpose: 'view' | 'download', d?: string): Promise<{ ok: true; url: string; sig: string } | { ok: false; why: OpenFail }> {
  const [link] = await sign([{ bucket: 'files', path: f.path, purpose, ...(d !== undefined ? { d } : {}) }]);
  if (!link || !link.ok || !link.sig) {
    const why = link && !link.ok ? failOf(link) : 'denied';
    rlog(`att ${purpose} sign ${why} code=${link && !link.ok ? link.code : 'no_sig'}`);
    return { ok: false, why };
  }
  return { ok: true, url: link.url, sig: link.sig };
}

/** 签一项、取字节；签名或取字节失败回原因 */
async function fetchSigned(f: FileRef, purpose: 'view' | 'download', d?: string): Promise<{ ok: true; blob: Blob } | { ok: false; why: OpenFail }> {
  const link = await signLink(f, purpose, d);
  if (!link.ok) return link;
  const b = await fetchBlob({ url: link.url, sig: link.sig });
  if (!b.ok) {
    rlog(`att ${purpose} fetch ${b.kind} code=${b.code}`);
    return { ok: false, why: failOf(b) };
  }
  return { ok: true, blob: b.blob };
}

/** 取到的字节核 sha256（和行上记的对不上就不交出去），对上了进缓存；预览、下载同一条规矩 */
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

/** 交出缓存里的那一份（不复制）：只许读；要转移进预览沙箱的，转移前自己 slice 一份（SandboxFrame） */
export async function openBytes(f: FileRef): Promise<OpenResult> {
  const hit = mem.get(f.id);
  if (hit) {
    rlog(`att open mem kind=${f.kind}`);
    return { ok: true, bytes: hit };
  }
  return fetchVerified(f, 'view');
}

export type DownloadResult = { ok: true; outcome: SaveOutcome } | { ok: false; why: OpenFail };
type ExeSaver = NonNullable<ReturnType<typeof exeSaver>>;
type ExeByteSaver = NonNullable<ReturnType<typeof exeByteSaver>>;

/**
 * Rust 回的错误码（lib.rs save_attachment、attachment.rs、attachment_win.rs）折成界面的原因（不要一律说成网络问题）：
 * • 写盘这一步失败（没权限、只读盘、来源标记写不进去）：换个文件夹；
 * • 正在存另一个：等它存完；文件太大：存不了；
 * • 请求本身不对（链接、签名、文件名、sha256 格式）、对话框打不开、Rust 里出错：再试也一样，不提示再试；
 * • 只有下载失败、超时（和认不出的码）才按网络问题，离线时说离线
 */
const EXE_FAIL: Record<string, OpenFail> = {
  mismatch: 'mismatch',
  file_type_mismatch: 'mismatch',
  download_refused: 'denied',
  write_failed: 'save_location',
  zone_mark_failed: 'save_location',
  bad_path: 'save_location',
  save_busy: 'save_busy',
  file_too_large: 'too_large',
  bad_url: 'save_failed',
  bad_sig: 'save_failed',
  bad_name: 'save_failed',
  bad_sha256: 'save_failed',
  dialog_failed: 'save_failed',
  save_failed: 'save_failed',
  unsupported: 'save_failed',
};
const exeFailOf = (code: string): OpenFail => (Object.hasOwn(EXE_FAIL, code) ? EXE_FAIL[code] : undefined) ?? (onlineNow() ? 'retry' : 'offline');

/** exe：签 download 链接交给 Rust 存（见文件头）。saved 折成 downloaded，cancelled 原样 */
async function exeDownload(f: FileRef, save: ExeSaver): Promise<DownloadResult> {
  const name = sanitizeFileName(f.name, f.kind);
  const link = await signLink(f, 'download', name);
  if (!link.ok) return link;
  const r = await save({ url: link.url, sig: link.sig, name, sha256: f.sha256 });
  rlog(`att download exe ${r.ok ? r.outcome : r.code} kind=${f.kind}`);
  if (r.ok) return { ok: true, outcome: r.outcome === 'saved' ? 'downloaded' : 'cancelled' };
  return { ok: false, why: exeFailOf(r.code) };
}

export async function download(f: FileRef, exe: ExeSaver | undefined = exeSaver()): Promise<DownloadResult> {
  if (exe) return exeDownload(f, exe);
  const hit = mem.get(f.id);
  const r = hit ? ({ ok: true, bytes: hit } as const) : await fetchVerified(f, 'download', sanitizeFileName(f.name, f.kind));
  return r.ok ? saveBytes(r.bytes, f) : r;
}

/**
 * 已经拿到明文字节：存到本机（普通、隐私记共用）。类型只取 DOC_TYPES 里这一类的，不沿用响应的 Content-Type。
 * exe 里交给 Rust 的 save_bytes（系统“另存为”、写盘带来源标记），结果和错误码同 exe 下载一样折
 */
export async function saveBytes(
  bytes: ArrayBuffer,
  f: Pick<FileRef, 'kind' | 'name'>,
  o: SaveOptions = {},
  exe: ExeByteSaver | undefined = exeByteSaver(),
): Promise<DownloadResult> {
  const name = sanitizeFileName(f.name, f.kind);
  if (exe) {
    const r = await exe(bytes, name);
    rlog(`att download exe-bytes ${r.ok ? r.outcome : r.code} kind=${f.kind}`);
    if (r.ok) return { ok: true, outcome: r.outcome === 'saved' ? 'downloaded' : 'cancelled' };
    return { ok: false, why: exeFailOf(r.code) };
  }
  const type = DOC_TYPES[f.kind];
  try {
    const outcome = await saveFile(new Blob([bytes], { type }), name, type, o);
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
