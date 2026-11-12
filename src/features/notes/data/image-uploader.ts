// 插图上传器（B4 S3）：编码 → 写行 → 等确认 → 上传，待传的图只放内存（规则见 note-images.ts 文件头）
// • 状态（给 hooks 用 useSyncExternalStore 订阅）：每张图 writing（行在排队）/ uploading / failed（带提示键）
// • 提示（onNotice）：插入、上传失败各发一条，页面出提示条；超限（quota）带“最近删除”入口
// • 依赖可注入；默认的接到 core（write.*、outbox、集合、离开本机）和 platform（files、会话）
// 纯 TS：不准 import React（A1）
import { createLeaveAccount, type AccountLeaveNotice } from '../../../core/account-leave.ts';
import { getBoot } from '../../../core/boot.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { OutboxRejectError } from '../../../core/outbox.ts';
import { collection, readonlyIds } from '../../../core/store.ts';
import { resolveFailedCreate } from '../../../core/write-failed-create.ts';
import { write } from '../../../core/write.ts';
import { clock } from '../../../platform/clock.ts';
import { accountExitOf, upload, type FileError, type UploadResult } from '../../../platform/files.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { readSessionId } from '../../../platform/session.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { encodeImage, type EncodeFail, type EncodeResult } from './image-encode.ts';
import { imageView, type ImageView } from './image-view.ts';
import { imageRow, rowSyncOf, thumbPath, uploadPair, uuidv7, writeFailKey, type ImgFailKey, type QueueItem, type RowSync } from './note-images.ts';

export interface PendingImage {
  id: string;
  noteId: string;
  path: string;
  /** 本机那一份的 blob: 地址（原图） */
  url: string;
  state: 'writing' | 'uploading' | 'failed';
  fail: ImgFailKey | null;
}

export type InsertResult = { ok: true; id: string } | { ok: false; code: EncodeFail['code'] | 'write_failed' | 'private' | 'readonly' | 'silent' };
export interface ImgNotice {
  key: ImgFailKey;
  noteId: string;
}

export interface UploaderDeps {
  userId(): string | null;
  tz(): Tz;
  now(): number;
  encode(file: File, tz: Tz): Promise<EncodeResult>;
  /** 写行：ok、没写进去（failed），或正在换账号（switching，不提示） */
  insert(row: Record<string, unknown> & { id: string }, noteId: string): Promise<'ok' | 'failed' | 'switching'>;
  queue(): Promise<readonly QueueItem[]>;
  /** 队列变了（含 error、rejected 事件）就叫一声 */
  onQueue(fn: () => void): () => void;
  rowExists(id: string): boolean;
  /** 这条随手记是不是隐私记（隐私记里不让插图，安全审建议 5：客户端先拦） */
  isPrivate(noteId: string): boolean;
  /** 这条随手记是不是只读行（带认不出的值，TC-B4-09“写入入口统一拦下”）：不让插图 */
  isReadonly(noteId: string): boolean;
  upload(path: string, blob: Blob): Promise<UploadResult>;
  sid(): string | null;
  exitOf(e: FileError, sid: string | null): Promise<AccountLeaveNotice | 'active' | null>;
  leave(notice: AccountLeaveNotice, sid: string | null): Promise<void>;
  /** 发送失败区里的新建：放弃；返回做成没有 */
  dropFailed(id: string): Promise<boolean>;
  softDelete(id: string): Promise<boolean>;
  objectUrl(b: Blob): string;
  revoke(url: string): void;
  sleep(ms: number): Promise<void>;
  view: ImageView;
  /** 等确认时最长多久自己再看一次队列（订阅漏了也不会一直卡住） */
  pollMs?: number;
  /** 运行日志（默认 platform 的 rlog；测试不给就不记）：每一步只记类型、大小、耗时、结果码，不记文字和图片内容 */
  log?: (line: string) => void;
}

export function createUploader(deps: UploaderDeps) {
  const log = deps.log ?? ((): void => undefined);
  // stage：失败在哪一段。row = 行没写成（被拒、写不进去），重传没用；file = 行已确认、图没传上，可以再传
  const items = new Map<string, PendingImage & { full: Blob; thumb: Blob; stage: 'row' | 'file' }>();
  let snap: readonly PendingImage[] = [];
  const subs = new Set<() => void>();
  const noticeSubs = new Set<(n: ImgNotice) => void>();

  const changed = (): void => {
    snap = [...items.values()].map(({ full: _f, thumb: _t, stage: _s, ...p }) => p);
    for (const f of subs) f();
  };
  const notify = (n: ImgNotice): void => {
    for (const f of noticeSubs) f(n);
  };
  const set = (id: string, p: Partial<PendingImage> & { stage?: 'row' | 'file' }): void => {
    const it = items.get(id);
    if (!it) return;
    items.set(id, { ...it, ...p });
    changed();
  };
  const fail = (id: string, key: ImgFailKey, stage: 'row' | 'file'): void => {
    const it = items.get(id);
    if (!it) return;
    log(`notes img fail stage=${stage} key=${key}`);
    set(id, { state: 'failed', fail: key, stage });
    notify({ key, noteId: it.noteId });
  };

  /** 等这一行在 outbox 里有了结果 */
  async function settle(id: string): Promise<RowSync> {
    for (;;) {
      const r = rowSyncOf(await deps.queue(), id, deps.rowExists(id));
      if (r.s !== 'pending') return r;
      await new Promise<void>((res) => {
        const t = setTimeout(done, deps.pollMs ?? 3000);
        const off = deps.onQueue(done);
        function done(): void {
          clearTimeout(t);
          off();
          res();
        }
      });
    }
  }

  async function send(id: string): Promise<void> {
    const it = items.get(id);
    if (!it) return;
    set(id, { state: 'uploading', fail: null });
    const sid = deps.sid();
    const t0 = deps.now();
    // 每次 PUT 失败记服务器原码（uploadPair 只交回界面用的失败键，原码会丢）
    const put = async (path: string, blob: Blob): Promise<UploadResult> => {
      const r = await deps.upload(path, blob);
      if (!r.ok) log(`notes img put ${path === it.path ? 'full' : 'thumb'} ${r.kind} code=${r.code}${r.reason ? ` reason=${r.reason}` : ''}`);
      return r;
    };
    const r = await uploadPair(put, it.path, it.full, it.thumb, deps.sleep);
    log(`notes img upload ${r === 'ok' ? 'ok' : typeof r === 'string' ? r : `${r.kind} code=${r.code}${r.reason ? ` reason=${r.reason}` : ''}`} ms=${deps.now() - t0}`);
    if (!items.has(id)) return;
    if (r === 'ok') {
      // 传上了：以后显示直接用本机那一份，这张图从待传里拿掉
      deps.view.seed(it.path, it.url);
      deps.view.seed(thumbPath(it.path), deps.objectUrl(it.thumb));
      items.delete(id);
      changed();
      return;
    }
    if (typeof r === 'string') return fail(id, r, 'file');
    const exit = await deps.exitOf(r, sid);
    if (exit === null || exit === 'active') return fail(id, 'retry', 'file');
    await deps.leave(exit, sid);
  }

  async function follow(id: string): Promise<void> {
    const r = await settle(id);
    log(`notes img row ${r.s}${r.s === 'failed' ? ` code=${r.code}` : ''}`);
    if (!items.has(id)) return;
    if (r.s === 'confirmed') return send(id);
    if (r.s === 'failed') return fail(id, writeFailKey(r.code), 'row');
    // 行没了（别处放弃了这一条）：本机这份也丢掉
    drop(id);
  }

  function drop(id: string): void {
    const it = items.get(id);
    if (!it) return;
    deps.revoke(it.url);
    items.delete(id);
    changed();
  }

  return {
    subscribe(fn: () => void): () => void {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    getSnapshot: (): readonly PendingImage[] => snap,
    onNotice(fn: (n: ImgNotice) => void): () => void {
      noticeSubs.add(fn);
      return () => noticeSubs.delete(fn);
    },
    /**
     * 给一条随手记插一张图：编码 → 写行；行写成了才开始等确认、上传。
     * note 可以是一个函数（输入行：编码成了才新建随手记，HEIC 这类打不开的不留一条空随手记）；它回 null 表示没建成（调用方自己提示）
     */
    async insert(note: string | (() => Promise<string | null>), file: File): Promise<InsertResult> {
      const t0 = deps.now();
      log(`notes img start type=${file.type || 'none'} kb=${Math.round(file.size / 1024)} new=${typeof note !== 'string'}`);
      const end = (r: InsertResult): InsertResult => {
        log(`notes img insert ${r.ok ? 'ok' : r.code} ms=${deps.now() - t0}`);
        return r;
      };
      const uid = deps.userId();
      if (uid === null) return end({ ok: false, code: 'silent' });
      if (typeof note === 'string' && deps.isPrivate(note)) return end({ ok: false, code: 'private' });
      if (typeof note === 'string' && deps.isReadonly(note)) return end({ ok: false, code: 'readonly' });
      const enc = await deps.encode(file, deps.tz());
      log(enc.ok ? `notes img encode ok kb=${Math.round(enc.full.size / 1024)} thumbKb=${Math.round(enc.thumb.size / 1024)} ${enc.width}x${enc.height}` : `notes img encode ${enc.code}`);
      if (!enc.ok) return end({ ok: false, code: enc.code });
      const noteId = typeof note === 'string' ? note : await note();
      if (noteId === null) return end({ ok: false, code: 'silent' });
      const id = uuidv7(deps.now());
      const row = imageRow(uid, noteId, id, { bytes: enc.full.size, width: enc.width, height: enc.height, takenAt: enc.takenAt });
      const w = await deps.insert(row, noteId);
      if (w !== 'ok') return end({ ok: false, code: w === 'switching' ? 'silent' : 'write_failed' });
      items.set(id, { id, noteId, path: String(row['path']), url: deps.objectUrl(enc.full), state: 'writing', fail: null, full: enc.full, thumb: enc.thumb, stage: 'row' });
      changed();
      void follow(id);
      return end({ ok: true, id });
    },
    /**
     * 再传一次：只管“行已确认、图没传上”这一段（主持人定）。行那一段失败的（超额、写不进去）、图不在内存里的回 false，
     * 界面走“重新选一张”（插成了再删旧的这张，旧行在发送失败区就放弃）
     */
    retry(id: string): boolean {
      const it = items.get(id);
      if (!it || it.state !== 'failed' || it.stage !== 'file') return false;
      set(id, { state: 'uploading', fail: null });
      void send(id);
      return true;
    },
    /** 删除一张图：发送失败区里的新建 → 放弃；不然软删，进“最近删除”。本机这一份一起丢 */
    async remove(id: string): Promise<boolean> {
      const r = rowSyncOf(await deps.queue(), id, deps.rowExists(id));
      const ok = r.s === 'failed' ? await deps.dropFailed(id) : r.s === 'gone' ? true : await deps.softDelete(id);
      if (ok) drop(id);
      return ok;
    },
  };
}

export type Uploader = ReturnType<typeof createUploader>;

const leave = createLeaveAccount();

/** 默认依赖（测试换掉其中几项，其余照真的走：write.*、outbox、集合） */
export const defaultUploaderDeps = (): UploaderDeps => ({
  userId: () => getBoot()?.userId ?? null,
  tz: currentTz,
  now: () => clock.now(),
  log: rlog,
  encode: encodeImage,
  async insert(row, noteId) {
    try {
      const r = await write.insert('note_images', row, { deps: [{ table: 'notes', id: noteId }] });
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
  rowExists: (id) => collection('note_images').get(id) !== undefined,
  isPrivate: (noteId) => collection<{ id: string; is_private?: unknown }>('notes').get(noteId)?.['is_private'] === true,
  isReadonly: (noteId) => readonlyIds('notes').getSnapshot().has(noteId),
  upload: (path, blob) => upload('images', path, blob, 'image/webp'),
  sid: () => readSessionId(),
  // accountExitOf 只回探测得出的原因（不会是 expired，那是会话过期，不经这里）；万一是，按被移除走
  async exitOf(e, sid) {
    const r = await accountExitOf(e, sid);
    return r === 'expired' ? 'removed' : r;
  },
  leave,
  async dropFailed(id) {
    return (await resolveFailedCreate('note_images', id, 'drop')).ok;
  },
  async softDelete(id) {
    try {
      return (await write.patch('note_images', id, { deleted_at: clock.now() })).ok;
    } catch (e) {
      if (e instanceof OutboxRejectError) return false;
      throw e;
    }
  },
  objectUrl: (b) => URL.createObjectURL(b),
  revoke: (u) => URL.revokeObjectURL(u),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  view: imageView(),
});

let shared: Uploader | null = null;
/** 整页一份（页面关了就没了：待传的图只在内存里，主持人定 1） */
export function uploader(): Uploader {
  shared ??= createUploader(defaultUploaderDeps());
  return shared;
}
export function resetUploaderForTest(u: Uploader | null = null): void {
  shared = u;
}
