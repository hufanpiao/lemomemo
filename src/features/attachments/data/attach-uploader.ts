// 附件上传器（架构 5.13 第 2 点 ⑥⑦“重新上传”、第 12 点；线框 sAtt）：本机判 → 写行 → 等确认 → PUT → file-check。待传的字节只放内存。
// • 本机判（file-prep.ts）不过的不写行，直接提示“这个文件没能加上：<原因>”（类型不认 / 超过 10 MB / 压缩包异常 / 带密码）
// • 写行：note_files 一行（check_status 服务器默认 pending，has_thumb = false，路径 media-path.ts 拼）经 write.insert，deps 指向这条随手记；
//   行被服务器拒（outbox error：quota_exceeded 等）→ 进发送失败区，这里提示“附件空间满了”或“没能加上”
// • 等行确认后 PUT /files（Content-Type 按 kind 取 DOC_TYPES）：网络、5xx、限流按 2 s、5 s、15 s 退避三次；
//   403 not_pending（上次其实传成了）不重传，看这一行的 check_status（0.33）；account 类走 accountExitOf → 离开本机
// • 传完调 file-check：ok 完；rejected 按原因提示；incomplete 补传原文件再调，最多 3 次；调不通（网络）就交给服务器每 10 分钟的补扫
// • 删除：发送失败区里的新建 → 放弃；不然软删 deleted_at（不进“最近删除”，提示条上“撤销”，架构 5.13 第 12 点）
// • 运行日志（rlog）：每一步只记类型、大小、结果码和耗时，不记文件名和内容
// 纯 TS：不准 import React（A1）
import { createLeaveAccount, type AccountLeaveNotice } from '../../../core/account-leave.ts';
import { getBoot } from '../../../core/boot.ts';
import { OutboxRejectError } from '../../../core/outbox.ts';
import { rowSyncOf, uuidv7, type QueueItem, type RowSync } from '../../../core/row-sync.ts';
import { collection, readonlyIds } from '../../../core/store.ts';
import { resolveFailedCreate } from '../../../core/write-failed-create.ts';
import { write } from '../../../core/write.ts';
import { clock } from '../../../platform/clock.ts';
import { accountExitOf, upload, type FileError, type UploadResult } from '../../../platform/files.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { readSessionId } from '../../../platform/session.ts';
import { noteFilePath } from '../../../../shared/logic/files/media-path.ts';
import type { DocKind } from '../../../../shared/manifests/attachments.ts';
import type { RejectReason } from '../../../../shared/schema/attachments.ts';
import { fileCheck, type CheckResult } from './file-check-api.ts';
import { prepareFile, type Prepared, type PrepFail } from './file-prep.ts';

export const TABLE = 'note_files';

/** 提示的几种（i18n 键 att.fail.<键>）；被拒的四种原因同 file-check 的 RejectReason */
export type AttFailKey = RejectReason | 'quota' | 'retry' | 'write' | 'upgrade' | 'denied' | 'empty';

export interface PendingFile {
  id: string;
  noteId: string;
  name: string;
  kind: DocKind;
  bytes: number;
  state: 'writing' | 'uploading' | 'checking' | 'failed';
  fail: AttFailKey | null;
}

export interface AttNotice {
  key: AttFailKey;
  noteId: string;
  /** 没能加上的那个文件名（本机判不过的，行不存在，提示里要写出名字） */
  name: string;
}

export type AddResult = { ok: true; id: string } | { ok: false; key: AttFailKey | 'silent' | 'private' | 'readonly' };

export interface AttUploaderDeps {
  userId(): string | null;
  now(): number;
  prepare(file: File): Promise<Prepared | PrepFail>;
  insert(row: Record<string, unknown> & { id: string }, noteId: string): Promise<'ok' | 'failed' | 'switching'>;
  queue(): Promise<readonly QueueItem[]>;
  onQueue(fn: () => void): () => void;
  row(id: string): { check_status?: unknown } | undefined;
  isPrivate(noteId: string): boolean;
  isReadonly(noteId: string): boolean;
  upload(path: string, blob: Blob, mime: string): Promise<UploadResult>;
  check(id: string): Promise<CheckResult>;
  sid(): string | null;
  exitOf(e: FileError, sid: string | null): Promise<AccountLeaveNotice | 'active' | null>;
  leave(notice: AccountLeaveNotice, sid: string | null): Promise<void>;
  dropFailed(id: string): Promise<boolean>;
  patch(id: string, data: Record<string, unknown>): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  pollMs?: number;
  log?: (line: string) => void;
}

/** PUT 的错误 → 提示；null = 退避重试 */
export function putFailKey(e: FileError): AttFailKey | null {
  if (e.reason === 'quota_exceeded' || e.code === 'quota_exceeded') return 'quota';
  switch (e.kind) {
    case 'retry':
    case 'auth':
    case 'resign':
      return null;
    case 'too_big':
      return 'too_big';
    case 'bad_type':
      return 'unknown';
    case 'upgrade':
      return 'upgrade';
    default:
      return 'denied';
  }
}

const BACKOFF = [2000, 5000, 15000] as const;
const CHECK_TRIES = 3;

export function createAttUploader(deps: AttUploaderDeps) {
  const log = deps.log ?? ((): void => undefined);
  const items = new Map<string, PendingFile & { blob: Blob; mime: string; path: string; stage: 'row' | 'file' }>();
  let snap: readonly PendingFile[] = [];
  const subs = new Set<() => void>();
  const noticeSubs = new Set<(n: AttNotice) => void>();

  const changed = (): void => {
    snap = [...items.values()].map(({ blob: _b, mime: _m, path: _p, stage: _s, ...p }) => p);
    for (const f of subs) f();
  };
  const notify = (n: AttNotice): void => {
    for (const f of noticeSubs) f(n);
  };
  const set = (id: string, p: Partial<PendingFile> & { stage?: 'row' | 'file' }): void => {
    const it = items.get(id);
    if (!it) return;
    items.set(id, { ...it, ...p });
    changed();
  };
  const fail = (id: string, key: AttFailKey, stage: 'row' | 'file'): void => {
    const it = items.get(id);
    if (!it) return;
    log(`att fail stage=${stage} key=${key}`);
    set(id, { state: 'failed', fail: key, stage });
    notify({ key, noteId: it.noteId, name: it.name });
  };
  const done = (id: string): void => {
    items.delete(id);
    changed();
  };

  async function settle(id: string): Promise<RowSync> {
    for (;;) {
      const r = rowSyncOf(await deps.queue(), TABLE, id, deps.row(id) !== undefined);
      if (r.s !== 'pending') return r;
      await new Promise<void>((res) => {
        const t = setTimeout(fin, deps.pollMs ?? 3000);
        const off = deps.onQueue(fin);
        function fin(): void {
          clearTimeout(t);
          off();
          res();
        }
      });
    }
  }

  /** PUT 原文件，退避重试；'ok'、'not_pending'、提示键或 account 类错误 */
  async function put(id: string): Promise<'ok' | 'not_pending' | AttFailKey | FileError> {
    const it = items.get(id);
    if (!it) return 'denied';
    for (let i = 0; ; i++) {
      const r = await deps.upload(it.path, it.blob, it.mime);
      if (r.ok) return 'ok';
      log(`att put ${r.kind} code=${r.code}${r.reason ? ` reason=${r.reason}` : ''}`);
      if (r.kind === 'not_pending') return 'not_pending';
      if (r.kind === 'account') return r;
      const k = putFailKey(r);
      if (k !== null) return k;
      const wait = BACKOFF[i];
      if (wait === undefined) return 'retry';
      await deps.sleep(wait);
    }
  }

  /** 行已经不在 pending（0.33）：ok 当成功；rejected 当“没能加上”；行没了就丢掉 */
  function byRowStatus(id: string): void {
    const st = deps.row(id)?.['check_status'];
    log(`att not_pending status=${typeof st === 'string' ? st : 'gone'}`);
    if (st === 'rejected') return fail(id, 'unknown', 'file');
    done(id);
  }

  async function send(id: string): Promise<void> {
    const t0 = deps.now();
    set(id, { state: 'uploading', fail: null });
    const sid = deps.sid();
    for (let tries = 0; tries < CHECK_TRIES; tries++) {
      const p = await put(id);
      if (!items.has(id)) return;
      if (p === 'not_pending') return byRowStatus(id);
      if (typeof p === 'object') {
        const exit = await deps.exitOf(p, sid);
        if (exit === null || exit === 'active') return fail(id, 'retry', 'file');
        return deps.leave(exit, sid);
      }
      if (p !== 'ok') return fail(id, p, 'file');
      set(id, { state: 'checking' });
      const c = await deps.check(id);
      log(`att check ${c.ok ? c.status : `${c.kind} code=${c.code}`} ms=${deps.now() - t0}`);
      if (!items.has(id)) return;
      if (!c.ok) {
        if (c.kind === 'upgrade') return fail(id, 'upgrade', 'file');
        // 调不通、行没了：字节已经传上，交给服务器补扫（界面照行上的 pending 显示“正在检查”）
        return done(id);
      }
      if (c.status === 'ok') return done(id);
      if (c.status === 'rejected') return fail(id, c.reason ?? 'unknown', 'file');
      // incomplete：对象还不在（PUT 回了成功但没写进去），再传一次
    }
    fail(id, 'retry', 'file');
  }

  async function follow(id: string): Promise<void> {
    const r = await settle(id);
    log(`att row ${r.s}${r.s === 'failed' ? ` code=${r.code}` : ''}`);
    if (!items.has(id)) return;
    if (r.s === 'confirmed') return send(id);
    if (r.s === 'failed') return fail(id, r.code === 'quota_exceeded' ? 'quota' : 'write', 'row');
    done(id);
  }

  return {
    subscribe(fn: () => void): () => void {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    getSnapshot: (): readonly PendingFile[] => snap,
    onNotice(fn: (n: AttNotice) => void): () => void {
      noticeSubs.add(fn);
      return () => noticeSubs.delete(fn);
    },
    /** 给一条随手记加一个文件（多选、拖进来时每个文件各调一次，各自报错） */
    async add(noteId: string, file: File): Promise<AddResult> {
      const t0 = deps.now();
      log(`att add start kb=${Math.round(file.size / 1024)}`);
      const end = (r: AddResult): AddResult => {
        log(`att add ${r.ok ? 'ok' : r.key} ms=${deps.now() - t0}`);
        if (!r.ok && r.key !== 'silent' && r.key !== 'private' && r.key !== 'readonly') notify({ key: r.key, noteId, name: file.name });
        return r;
      };
      const uid = deps.userId();
      if (uid === null) return end({ ok: false, key: 'silent' });
      if (deps.isPrivate(noteId)) return end({ ok: false, key: 'private' });
      if (deps.isReadonly(noteId)) return end({ ok: false, key: 'readonly' });
      const p = await deps.prepare(file);
      log(p.ok ? `att prep ok kind=${p.kind} kb=${Math.round(p.bytes.length / 1024)}` : `att prep ${p.reason} detail=${p.detail}`);
      if (!p.ok) return end({ ok: false, key: p.reason });
      const id = uuidv7(deps.now());
      const now = deps.now();
      const path = noteFilePath(uid, noteId, id, p.kind);
      const row = { id, note_id: noteId, kind: p.kind, path, has_thumb: false, name: p.name, mime: p.mime, bytes: p.bytes.length, sha256: p.sha256, pages: null, text_excerpt: null, created_at: now, updated_at: now };
      const w = await deps.insert(row, noteId);
      if (w !== 'ok') return end({ ok: false, key: w === 'switching' ? 'silent' : 'write' });
      items.set(id, { id, noteId, name: p.name, kind: p.kind, bytes: p.bytes.length, state: 'writing', fail: null, blob: new Blob([p.bytes as BlobPart], { type: p.mime }), mime: p.mime, path, stage: 'row' });
      changed();
      void follow(id);
      return end({ ok: true, id });
    },
    /** 再传一次：只管“行已确认、文件没传上”；别的回 false（界面让用户重新选） */
    retry(id: string): boolean {
      const it = items.get(id);
      if (!it || it.state !== 'failed' || it.stage !== 'file') return false;
      void send(id);
      return true;
    },
    /** 删一个附件：发送失败区里的新建 → 放弃；不然软删。本机这份一起丢 */
    async remove(id: string): Promise<boolean> {
      const r = rowSyncOf(await deps.queue(), TABLE, id, deps.row(id) !== undefined);
      const ok = r.s === 'failed' ? await deps.dropFailed(id) : r.s === 'gone' ? true : await deps.patch(id, { deleted_at: deps.now() });
      log(`att remove ${r.s} ${ok ? 'ok' : 'failed'}`);
      if (ok) done(id);
      return ok;
    },
    /** 撤销删除（提示条上的“撤销”） */
    async undoRemove(id: string): Promise<boolean> {
      const ok = await deps.patch(id, { deleted_at: null });
      log(`att undo_remove ${ok ? 'ok' : 'failed'}`);
      return ok;
    },
  };
}

export type AttUploader = ReturnType<typeof createAttUploader>;

const leave = createLeaveAccount();

async function patchRow(id: string, data: Record<string, unknown>): Promise<boolean> {
  try {
    return (await write.patch(TABLE, id, { ...data, updated_at: clock.now() })).ok;
  } catch (e) {
    if (e instanceof OutboxRejectError) return false;
    throw e;
  }
}

export const defaultAttDeps = (): AttUploaderDeps => ({
  userId: () => getBoot()?.userId ?? null,
  now: () => clock.now(),
  log: rlog,
  prepare: prepareFile,
  async insert(row, noteId) {
    try {
      const r = await write.insert(TABLE, row, { deps: [{ table: 'notes', id: noteId }] });
      return r.ok ? 'ok' : r.reason === 'switching' ? 'switching' : 'failed';
    } catch (e) {
      if (e instanceof OutboxRejectError) return 'failed';
      throw e;
    }
  },
  queue: async () => (await getBoot()?.outbox?.list()) ?? [],
  onQueue(fn) {
    const o = getBoot()?.outbox;
    if (!o) return () => undefined;
    const a = o.subscribe(fn);
    const b = o.onEvent((e) => {
      if (e.type === 'error' || e.type === 'rejected') fn();
    });
    return () => {
      a();
      b();
    };
  },
  row: (id) => collection<{ id: string; check_status?: unknown }>(TABLE).get(id),
  isPrivate: (noteId) => collection<{ id: string; is_private?: unknown }>('notes').get(noteId)?.['is_private'] === true,
  isReadonly: (noteId) => readonlyIds('notes').getSnapshot().has(noteId),
  upload: (path, blob, mime) => upload('files', path, blob, mime),
  check: (id) => fileCheck(id),
  sid: () => readSessionId(),
  async exitOf(e, sid) {
    const r = await accountExitOf(e, sid);
    return r === 'expired' ? 'removed' : r;
  },
  leave,
  async dropFailed(id) {
    return (await resolveFailedCreate(TABLE, id, 'drop')).ok;
  },
  patch: patchRow,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

let shared: AttUploader | null = null;
/** 整页一份（待传的字节只在内存里，页面关了就没了；行上的 pending 交给服务器补扫判） */
export function attUploader(): AttUploader {
  shared ??= createAttUploader(defaultAttDeps());
  return shared;
}
export function resetAttUploaderForTest(u: AttUploader | null = null): void {
  shared = u;
}
