// 附件上传器（架构 5.13 第 2 点 ⑥⑦“重新上传”、第 12 点；线框 sAtt）：本机判 → 写行 → 等确认 → PUT → file-check。待传的字节只放内存。
// • 本机判（file-prep.ts）不过的不写行，直接提示“这个文件没能加上：<原因>”（类型不认 / 超过 10 MB / 压缩包异常 / 带密码）
// • 预览材料（5.13 第 2 点 ④）：能预览的格式由界面传进来的 extract（隐藏的预览沙箱）给页数、纯文本（≤ 20000 字）、首页缩略图（webp）；
//   拿不到就照常加（has_thumb false、pages、text_excerpt 为空），不因为缩略图失败拒收文件
// • 写行：note_files 一行（check_status 服务器默认 pending，has_thumb = false，路径 media-path.ts 拼）经 write.insert，deps 指向这条随手记；
//   行被服务器拒（outbox error：quota_exceeded 等）→ 进发送失败区，这里提示“附件空间满了”或“没能加上”
// • 等行确认后 PUT /files：原文件（Content-Type 按 kind 取 DOC_TYPES），有缩略图再 PUT <id>.t.webp（顺序同 5.13 第 2 点“重新上传”）；可重试的错误退避三次（core/row-sync.ts 的 putWithBackoff）；
//   403 not_pending（上次其实传成了）不重传，看这一行的 check_status（0.33）；account 类走 accountExitOf → 离开本机
// • 传完调 file-check：ok 完；rejected 按原因提示；incomplete 补传原文件再调，最多 3 次；调不通（网络）就交给服务器每 10 分钟的补扫
// • 删除：发送失败区里的新建 → 放弃（没有撤销）；不然软删 deleted_at（不进“最近删除”，提示条上“撤销”，架构 5.13 第 12 点）
// • 运行日志（rlog）：每一步只记类型、大小、结果码和耗时，不记文件名和内容
// 写行、等确认、待传列表、默认依赖和插图上传器共用 core/row-sync.ts；这里只写判型、拼行、PUT 之后的 file-check。
// 纯 TS：不准 import React（A1）
import { pendingList, putFailOf, putParts, rowState, rowUploadDefaults, waitRow, type RowUploadDeps } from '../../../core/row-sync.ts';
import { uuidv7 } from '../../../core/uuidv7.ts';
import { collection } from '../../../core/store.ts';
import { clock } from '../../../platform/clock.ts';
import { upload, type FileError, type UploadResult } from '../../../platform/files.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { noteFilePath, noteFileThumbPath } from '../../../../shared/logic/files/media-path.ts';
import type { DocKind } from '../../../../shared/manifests/attachments.ts';
import type { RejectReason } from '../../../../shared/schema/attachments.ts';
import { fileCheck, type CheckResult } from './file-check-api.ts';
import { prepareFile, prepWithExtras, type Extract, type Prepared, type PrepFail } from './file-prep.ts';

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
export type { Extract, Extras } from './file-prep.ts';

/** 删除的结果：soft = 软删了（可以撤销）；dropped = 行没写成、放弃了或本来就没了（没什么可撤销）；false = 没删成 */
export type RemoveResult = 'soft' | 'dropped' | false;

export interface AttUploaderDeps extends RowUploadDeps {
  now(): number;
  prepare(file: File): Promise<Prepared | PrepFail>;
  /** 本机集合里这一行的 check_status（行在不在看 rowExists） */
  checkStatus(id: string): unknown;
  upload(path: string, blob: Blob, mime: string): Promise<UploadResult>;
  check(id: string): Promise<CheckResult>;
  log?: (line: string) => void;
}

/** PUT 的错误 → 提示；null = 退避重试（分类在 core/row-sync.ts；附件的“类型不认”提示叫 unknown，没有单独的“长度不对”，归 denied） */
export function putFailKey(e: FileError): AttFailKey | null {
  const k = putFailOf(e);
  return k === 'bad_type' ? 'unknown' : k === 'length' ? 'denied' : k;
}

const CHECK_TRIES = 3;
/** file-check 回 rate_limited（每人每分钟限次）时等这么久再查一次（第二轮复查 #14：一次多选几十个时，后面的不用等补扫的半小时） */
export const RATE_WAIT_MS = 60_000;
type Part = { path: string; blob: Blob; mime: string };
type Item = PendingFile & { parts: Part[]; stage: 'row' | 'file' };

export function createAttUploader(deps: AttUploaderDeps) {
  const log = deps.log ?? ((): void => undefined);
  const list = pendingList<PendingFile, Omit<Item, keyof PendingFile>, AttNotice>(({ parts: _p, stage: _s, ...p }) => p);
  const { items } = list;
  const fail = (id: string, key: AttFailKey, stage: 'row' | 'file'): void => {
    const it = items.get(id);
    if (!it) return;
    log(`att fail stage=${stage} key=${key}`);
    list.set(id, { state: 'failed', fail: key, stage });
    list.notify({ key, noteId: it.noteId, name: it.name });
  };

  /** 原文件、缩略图依次 PUT；'not_pending'（上次其实传成了）单独回，交给 byRowStatus */
  const put = (it: Item): Promise<'ok' | 'not_pending' | AttFailKey | FileError> =>
    putParts<Part, AttFailKey | 'not_pending'>(
      it.parts,
      async (x) => {
        const r = await deps.upload(x.path, x.blob, x.mime);
        if (!r.ok) log(`att put ${r.kind} code=${r.code}${r.reason ? ` reason=${r.reason}` : ''}`);
        return r;
      },
      (e) => (e.kind === 'not_pending' ? 'not_pending' : putFailKey(e)),
      'retry',
      deps.sleep,
    );

  /** 行已经不在 pending（0.33）：ok 当成功；rejected 当“没能加上”；行没了就丢掉 */
  function byRowStatus(id: string): void {
    const st = deps.checkStatus(id);
    log(`att not_pending status=${typeof st === 'string' ? st : 'gone'}`);
    if (st === 'rejected') return fail(id, 'unknown', 'file');
    list.drop(id);
  }

  async function send(id: string): Promise<void> {
    const t0 = deps.now();
    list.set(id, { state: 'uploading', fail: null });
    const sid = deps.sid();
    for (let tries = 0; tries < CHECK_TRIES; tries++) {
      const it = items.get(id);
      if (!it) return;
      const p = await put(it);
      if (!items.has(id)) return;
      if (p === 'not_pending') return byRowStatus(id);
      if (typeof p === 'object') {
        const exit = await deps.exitOf(p, sid);
        if (exit === null || exit === 'active') return fail(id, 'retry', 'file');
        return deps.leave(exit, sid);
      }
      if (p !== 'ok') return fail(id, p, 'file');
      list.set(id, { state: 'checking' });
      let c = await deps.check(id);
      if (!c.ok && c.code === 'rate_limited') {
        await deps.sleep(RATE_WAIT_MS);
        if (!items.has(id)) return;
        c = await deps.check(id);
      }
      log(`att check ${c.ok ? c.status : `${c.kind} code=${c.code}`} ms=${deps.now() - t0}`);
      if (!items.has(id)) return;
      if (!c.ok) {
        if (c.kind === 'upgrade') return fail(id, 'upgrade', 'file');
        // 调不通、行没了、会话不对：字节已经传上，交给服务器补扫（界面照行上的 pending 显示“正在检查”；会话被吊销由全局的登录处理收尾）
        return list.drop(id);
      }
      if (c.status === 'ok') return list.drop(id);
      if (c.status === 'rejected') return fail(id, c.reason ?? 'unknown', 'file');
      // incomplete：对象还不在（PUT 回了成功但没写进去），再传一次
    }
    fail(id, 'retry', 'file');
  }

  async function follow(id: string): Promise<void> {
    const r = await waitRow(deps, TABLE, id);
    log(`att row ${r.s}${r.s === 'failed' ? ` code=${r.code}` : ''}`);
    if (!items.has(id)) return;
    if (r.s === 'confirmed') return send(id);
    if (r.s === 'failed') return fail(id, r.code === 'quota_exceeded' ? 'quota' : 'write', 'row');
    list.drop(id);
  }

  return {
    ...list.api,
    /** 给一条随手记加一个文件（多选、拖进来时每个文件各调一次，各自报错） */
    async add(noteId: string, file: File, extract?: Extract): Promise<AddResult> {
      const t0 = deps.now();
      log(`att add start kb=${Math.round(file.size / 1024)}`);
      const end = (r: AddResult): AddResult => {
        log(`att add ${r.ok ? 'ok' : r.key} ms=${deps.now() - t0}`);
        if (!r.ok && r.key !== 'silent' && r.key !== 'private' && r.key !== 'readonly') list.notify({ key: r.key, noteId, name: file.name });
        return r;
      };
      const uid = deps.userId();
      if (uid === null) return end({ ok: false, key: 'silent' });
      if (deps.isPrivate(noteId)) return end({ ok: false, key: 'private' });
      if (deps.isReadonly(noteId)) return end({ ok: false, key: 'readonly' });
      const r = await prepWithExtras(file, deps.prepare, extract, log, 'att');
      if (!r.ok) return end({ ok: false, key: r.reason });
      const { p, x } = r;
      const id = uuidv7(deps.now());
      const now = deps.now();
      const path = noteFilePath(uid, noteId, id, p.kind);
      const thumb = x?.thumb ?? null;
      const row = { id, note_id: noteId, kind: p.kind, path, has_thumb: thumb !== null, name: p.name, mime: p.mime, bytes: p.bytes.length, sha256: p.sha256, pages: x?.pages ?? null, text_excerpt: x?.text || null, created_at: now, updated_at: now };
      const w = await deps.insert(row, noteId);
      if (w !== 'ok') return end({ ok: false, key: w === 'switching' ? 'silent' : 'write' });
      items.set(id, { id, noteId, name: p.name, kind: p.kind, bytes: p.bytes.length, state: 'writing', fail: null, parts: [{ path, blob: new Blob([p.bytes as BlobPart], { type: p.mime }), mime: p.mime }, ...(thumb ? [{ path: noteFileThumbPath(uid, noteId, id), blob: thumb, mime: 'image/webp' }] : [])], stage: 'row' });
      list.changed();
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
    /** 删一个附件：发送失败区里的新建 → 放弃；行本来就没了 → 算删掉；不然软删。本机这份一起丢 */
    async remove(id: string): Promise<RemoveResult> {
      const r = await rowState(deps, TABLE, id);
      const res: RemoveResult =
        r.s === 'failed' ? ((await deps.dropFailed(id)) ? 'dropped' : false)
        : r.s === 'gone' ? 'dropped'
        : (await deps.patch(id, { deleted_at: deps.now(), updated_at: deps.now() })) ? 'soft' : false;
      log(`att remove ${r.s} ${res === false ? 'failed' : res}`);
      if (res !== false) list.drop(id);
      return res;
    },
    /** 撤销删除（提示条上的“撤销”，只给软删的） */
    async undoRemove(id: string): Promise<boolean> {
      const ok = await deps.patch(id, { deleted_at: null, updated_at: deps.now() });
      log(`att undo_remove ${ok ? 'ok' : 'failed'}`);
      return ok;
    },
  };
}

export type AttUploader = ReturnType<typeof createAttUploader>;

export const defaultAttDeps = (): AttUploaderDeps => ({
  ...rowUploadDefaults(TABLE),
  now: () => clock.now(),
  log: rlog,
  prepare: prepareFile,
  checkStatus: (id) => collection<{ id: string; check_status?: unknown }>(TABLE).get(id)?.check_status,
  upload: (path, blob, mime) => upload('files', path, blob, mime),
  check: (id) => fileCheck(id),
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
