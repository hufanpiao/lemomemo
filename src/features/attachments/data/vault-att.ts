// 隐私记里自己加的文档附件（B4b-1；架构 5.13 第 11 点、方案-文件存储改用R2 4.8 节、R-118 D-12）：给附件区的那一份动作
// • 经隐私记会话调 vault-file 函数（传输由隐私记功能给，这里只认 VaultFileApi 接口：令牌、上锁、续期都在那边）
// • 上传：本机先判（file-prep.ts，同普通附件）→ 预览沙箱抽页数、文字、缩略图（同普通附件）→ multipart 一次传明文给函数，服务器重做检查、加密写进 vault-files；
//   不写本机库、不进 outbox（明文不落本机，A18）。传上就算检查过了（服务器当场检查），列表直接出
// • 列表、取字节：list 回解密后的文件名；get 回解密后的字节，只放本附件区的内存（memCache），附件区卸下（上锁、离开编辑页）就丢
// • 删除：remove 写 deleted_at，提示条“撤销”调 restore
// • PPT：ms_preview 让服务器放一份临时明文副本（5 分钟），交给微软；关预览、卸下附件区时 ms_preview_end 立即删
// • 运行日志只记动作和结果码，不记文件名、内容
// 纯 TS：不准 import React（A1）
import type { RejectReason } from '../../../../shared/schema/attachments.ts';
import type { VaultFileItem, VaultFileMeta } from '../../../../shared/schema/vault-file.ts';
import { uuidv7 } from '../../../core/row-sync.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { AttSource } from './att-source.ts';
import type { NoteFile } from './attach-list.ts';
import { memCache, msEmbedOf, saveBytes, shareBytes, type OpenResult } from './attach-open.ts';
import type { AddResult, AttFailKey, AttNotice, Extract, PendingFile } from './attach-uploader.ts';
import { prepareFile, type Prepared, type PrepFail } from './file-prep.ts';

/** 失败：code 是 vault-file 的错误码或传输层的码（offline、stale 等）；rejected 带 reason */
export type VaultFileFail = { ok: false; code: string; reason?: RejectReason };
type R<T> = ({ ok: true } & T) | VaultFileFail;

/** 隐私记功能给的传输（带会话令牌；锁着、半路上锁回失败，上锁由会话自己落） */
export interface VaultFileApi {
  list(noteId: string): Promise<R<{ files: VaultFileItem[] }>>;
  upload(meta: VaultFileMeta, file: Blob, thumb: Blob | null): Promise<R<{ file: VaultFileItem }>>;
  get(id: string, part: 'full' | 'thumb'): Promise<R<{ blob: Blob }>>;
  remove(id: string): Promise<R<object>>;
  restore(id: string): Promise<R<object>>;
  /** 回同源相对地址（/sb/storage/v1/object/sign/vault-preview/…） */
  msPreview(id: string): Promise<R<{ url: string }>>;
  /** 立即删临时明文副本；fire-and-forget（页面隐藏、上锁时用 keepalive） */
  msPreviewEnd(): void;
}

export interface VaultAttDeps {
  prepare(file: File): Promise<Prepared | PrepFail>;
  now(): number;
  origin(): string;
}

const defaults: VaultAttDeps = { prepare: prepareFile, now: () => Date.now(), origin: () => location.origin };

export interface VaultAttSnapshot {
  loaded: boolean;
  files: readonly NoteFile[];
  pending: readonly PendingFile[];
}

const toFile = (x: VaultFileItem): NoteFile => ({
  id: x.id,
  noteId: x.note_id,
  path: '',
  kind: x.kind,
  name: x.name,
  sha256: '',
  bytes: x.bytes,
  check: 'ok',
  pages: x.pages !== null && x.pages > 0 ? x.pages : null,
  hasThumb: x.has_thumb,
});

/** 上传失败的码 → 附件区的提示键；锁着、半路上锁回 null（不提示：隐私记页面自己会换成解锁卡） */
export function failKeyOf(f: VaultFileFail): AttFailKey | null {
  switch (f.code) {
    case 'rejected':
      return f.reason ?? 'unknown';
    case 'too_large':
      return 'too_big';
    case 'quota_exceeded':
      return 'quota';
    case 'offline':
    case 'try_later':
    case 'rate_limited':
      return 'retry';
    case 'upgrade_required':
      return 'upgrade';
    case 'vault_locked':
    case 'vault_relock':
    case 'stale':
    case 'cancelled':
    case 'session_revoked':
      return null;
    default:
      return 'write';
  }
}

type Retry = { meta: VaultFileMeta; file: Blob; thumb: Blob | null };

/** 一个附件区一份（noteId 固定）；dispose 时丢掉内存里的明文、结束微软预览 */
export function createVaultAtt(api: VaultFileApi, noteId: string, deps: VaultAttDeps = defaults) {
  let snap: VaultAttSnapshot = { loaded: false, files: [], pending: [] };
  const subs = new Set<() => void>();
  const notices = new Set<(n: AttNotice) => void>();
  const mem = memCache();
  const retries = new Map<string, Retry>();
  /** 删掉还能撤销的（撤销时放回原位） */
  const removed = new Map<string, NoteFile>();
  let msOn = false;
  let dead = false;

  const put = (p: Partial<VaultAttSnapshot>): void => {
    if (dead) return;
    snap = { ...snap, ...p };
    for (const fn of [...subs]) fn();
  };
  const setPending = (id: string, patch: Partial<PendingFile> | null): void => {
    const rest = snap.pending.filter((x) => x.id !== id);
    const old = snap.pending.find((x) => x.id === id);
    put({ pending: patch === null || !old ? rest : snap.pending.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  };
  const notify = (key: AttFailKey, name: string): void => {
    for (const fn of [...notices]) fn({ key, noteId, name });
  };
  const sortIn = (files: readonly NoteFile[], f: NoteFile): NoteFile[] => [...files.filter((x) => x.id !== f.id), f].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  async function load(): Promise<void> {
    const r = await api.list(noteId);
    rlog(`vatt list ${r.ok ? `ok n=${r.files.length}` : r.code}`);
    if (r.ok) put({ loaded: true, files: r.files.map(toFile) });
    else put({ loaded: true });
  }

  async function send(id: string, x: Retry): Promise<void> {
    setPending(id, { state: 'uploading', fail: null });
    const t0 = deps.now();
    const r = await api.upload(x.meta, x.file, x.thumb);
    rlog(`vatt upload ${r.ok ? 'ok' : r.code}${!r.ok && r.reason ? ` reason=${r.reason}` : ''} ms=${deps.now() - t0}`);
    if (r.ok || r.code === 'exists') {
      retries.delete(id);
      setPending(id, null);
      if (r.ok) put({ files: sortIn(snap.files, toFile(r.file)) });
      else await load();
      return;
    }
    const key = failKeyOf(r);
    if (key === null) {
      retries.delete(id);
      return setPending(id, null);
    }
    if (key !== 'retry') retries.delete(id);
    setPending(id, { state: 'failed', fail: key });
    notify(key, x.meta.name);
  }

  const source: AttSource = {
    scope: 'vault',
    async add(nid: string, file: File, extract?: Extract): Promise<AddResult> {
      if (nid !== noteId) return { ok: false, key: 'silent' };
      const p = await deps.prepare(file);
      rlog(p.ok ? `vatt prep ok kind=${p.kind} kb=${Math.round(p.bytes.length / 1024)}` : `vatt prep ${p.reason}`);
      if (!p.ok) {
        notify(p.reason, file.name);
        return { ok: false, key: p.reason };
      }
      const x = extract ? await extract(p.bytes, p.kind).catch(() => null) : null;
      if (extract) rlog(`vatt extract ${x ? `ok pages=${x.pages ?? '-'} thumb=${x.thumb ? 1 : 0}` : 'none'}`);
      const id = uuidv7(deps.now());
      const meta: VaultFileMeta = { id, note_id: noteId, kind: p.kind, name: p.name, sha256: p.sha256, bytes: p.bytes.length, pages: x?.pages ?? null, text: x?.text || null };
      const job: Retry = { meta, file: new Blob([p.bytes as BlobPart], { type: p.mime }), thumb: x?.thumb ?? null };
      retries.set(id, job);
      put({ pending: [...snap.pending, { id, noteId, name: p.name, kind: p.kind, bytes: p.bytes.length, state: 'uploading', fail: null }] });
      void send(id, job);
      return { ok: true, id };
    },
    retry(id) {
      const x = retries.get(id);
      if (!x) return false;
      void send(id, x);
      return true;
    },
    async remove(id) {
      if (snap.pending.some((x) => x.id === id)) {
        retries.delete(id);
        setPending(id, null);
        return 'dropped';
      }
      const f = snap.files.find((x) => x.id === id);
      const r = await api.remove(id);
      rlog(`vatt remove ${r.ok ? 'ok' : r.code}`);
      if (!r.ok) return r.code === 'not_found' ? 'dropped' : false;
      if (f) removed.set(id, f);
      put({ files: snap.files.filter((x) => x.id !== id) });
      return 'soft';
    },
    async undoRemove(id) {
      const r = await api.restore(id);
      rlog(`vatt restore ${r.ok ? 'ok' : r.code}`);
      const f = removed.get(id);
      removed.delete(id);
      if (r.ok && f) put({ files: sortIn(snap.files, f) });
      return r.ok;
    },
    async open(f): Promise<OpenResult> {
      const hit = mem.get(f.id);
      if (hit) return { ok: true, bytes: hit };
      const r = await api.get(f.id, 'full');
      rlog(`vatt get ${r.ok ? 'ok' : r.code} kind=${f.kind}`);
      if (!r.ok) return { ok: false, why: r.code === 'offline' ? 'offline' : r.code === 'not_found' || r.code === 'corrupt' ? 'denied' : 'retry' };
      const bytes = await r.blob.arrayBuffer();
      mem.set(f.id, bytes);
      return { ok: true, bytes };
    },
    async download(f) {
      const r = await source.open(f);
      return r.ok ? saveBytes(r.bytes, f) : r;
    },
    async share(f) {
      const r = await source.open(f);
      return r.ok ? shareBytes(r.bytes, f) : r;
    },
    async msUrl(f) {
      if (f.kind !== 'pptx') return null;
      const r = await api.msPreview(f.id);
      rlog(`vatt ms_preview ${r.ok ? 'ok' : r.code}`);
      if (!r.ok) return null;
      msOn = true;
      return msEmbedOf(`${deps.origin()}${r.url}`);
    },
    msEnd() {
      if (!msOn) return;
      msOn = false;
      rlog('vatt ms_preview_end');
      api.msPreviewEnd();
    },
    inMemory: (id) => mem.has(id),
    async thumb(f) {
      if (!f.hasThumb) return null;
      const r = await api.get(f.id, 'thumb');
      return r.ok ? r.blob : null;
    },
    onNotice(fn) {
      notices.add(fn);
      return () => {
        notices.delete(fn);
      };
    },
  };

  return {
    source,
    load,
    get: (): VaultAttSnapshot => snap,
    subscribe(fn: () => void): () => void {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    /** 附件区卸下：丢掉明文、结束微软预览、不再通知 */
    dispose(): void {
      source.msEnd();
      mem.clear();
      retries.clear();
      removed.clear();
      dead = true;
      subs.clear();
      notices.clear();
    },
  };
}

export type VaultAtt = ReturnType<typeof createVaultAtt>;
