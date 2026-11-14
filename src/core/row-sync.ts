// “先写行再传字节”的共用部分（B4 插图 S3 起；B4b-1 附件同一套）：插图（features/notes/data/image-uploader.ts）和附件
//   （features/attachments/data/attach-uploader.ts）都等这一行上了服务器再 PUT 对象（files_authorize 只许已有这一行的路径上传，
//   架构 5.13 第 2 点 ⑥、第四轮架构 L3）。两边只各写自己的“编码 / 判型、拼行、PUT 后做什么”，其余都在这里：
//   时间有序的 id、行在 outbox 里的情况和等它有结果、退避重试的 PUT、待传列表（给 useSyncExternalStore 订阅）、默认接到 core 的依赖。
// 纯 TS：不准 import React（A1）
import { createLeaveAccount, type AccountLeaveNotice } from './account-leave.ts';
import { getBoot } from './boot.ts';
import { OutboxRejectError } from './outbox.ts';
import { collection, readonlyIds } from './store.ts';
import { resolveFailedCreate } from './write-failed-create.ts';
import { write } from './write.ts';
import { accountExitOf, type FileError, type UploadResult } from '../platform/files.ts';
import { readSessionId } from '../platform/session.ts';

export { uuidv7 } from './uuidv7.ts';

/** 这一行在 outbox 里的情况：pending 还在排、failed 进了发送失败区（带码）、confirmed 上了服务器、gone 行没了 */
export type RowSync = { s: 'pending' } | { s: 'failed'; code: string | null } | { s: 'confirmed' } | { s: 'gone' };

export interface QueueItem {
  rec: string;
  state: 'pending' | 'inflight' | 'failed';
  error: string | null;
}

/** table 这一行（id）在 outbox 里的情况；rowExists：本机集合里还有没有这一行 */
export function rowSyncOf(items: readonly QueueItem[], table: string, id: string, rowExists: boolean): RowSync {
  const mine = items.filter((x) => x.rec === `${table}:${id}`);
  const failed = mine.find((x) => x.state === 'failed');
  if (failed) return { s: 'failed', code: failed.error };
  if (mine.length) return { s: 'pending' };
  return rowExists ? { s: 'confirmed' } : { s: 'gone' };
}

/** outbox 的读法（可注入，测试换成假的） */
export interface RowQueue {
  queue(): Promise<readonly QueueItem[]>;
  /** 队列变了（含 error、rejected 事件）就叫一声 */
  onQueue(fn: () => void): () => void;
  /** 等确认时最长多久自己再看一次队列（订阅漏了也不会一直卡住） */
  pollMs?: number;
}

/** 判断“本机集合里还有没有这一行”只有这一种写法（rowExists），插图、附件共用（B4b-1 第二轮复查：原来一边 rowExists、一边 row(id) 再包一层） */
export interface RowLookup extends RowQueue {
  rowExists(id: string): boolean;
}

/** 这一行现在的情况（删除时决定放弃还是软删） */
export async function rowState(q: RowLookup, table: string, id: string): Promise<RowSync> {
  return rowSyncOf(await q.queue(), table, id, q.rowExists(id));
}

/** 等这一行在 outbox 里有了结果（不再是 pending） */
export async function waitRow(q: RowLookup, table: string, id: string): Promise<RowSync> {
  for (;;) {
    const r = await rowState(q, table, id);
    if (r.s !== 'pending') return r;
    await new Promise<void>((res) => {
      const t = setTimeout(fin, q.pollMs ?? 3000);
      const off = q.onQueue(fin);
      function fin(): void {
        clearTimeout(t);
        off();
        res();
      }
    });
  }
}

/** 网络、5xx、限流、登录刷新、签名过期这类可重试的 PUT 错误，按 2 s、5 s、15 s 退避三次 */
export const PUT_BACKOFF = [2000, 5000, 15000] as const;

/**
 * PUT 一个对象，可重试的错误退避重试；返回 'ok'、提示键（failKey 给的，退避用完回 retryKey），或 account 类错误（交给调用方离开本机）。
 * failKey 回 null = 可以退避重试
 */
export async function putWithBackoff<K>(
  put: () => Promise<UploadResult>,
  failKey: (e: FileError) => K | null,
  retryKey: K,
  sleep: (ms: number) => Promise<void>,
  backoff: readonly number[] = PUT_BACKOFF,
): Promise<'ok' | K | FileError> {
  for (let i = 0; ; i++) {
    const r = await put();
    if (r.ok) return 'ok';
    if (r.kind === 'account') return r;
    const k = failKey(r);
    if (k !== null) return k;
    const wait = backoff[i];
    if (wait === undefined) return retryKey;
    await sleep(wait);
  }
}

/** PUT 失败的分类（插图、附件两个上传器共用，各自再换成自己的提示键）；null = 可以退避重试（网络、5xx、限流、登录刷新、签名过期） */
export type PutFail = 'quota' | 'length' | 'too_big' | 'bad_type' | 'upgrade' | 'denied';
const LENGTH = new Set(['length_mismatch', 'length_required']);
export function putFailOf(e: FileError): PutFail | null {
  if (e.reason === 'quota_exceeded' || e.code === 'quota_exceeded') return 'quota';
  if (LENGTH.has(e.code) || (e.reason !== undefined && LENGTH.has(e.reason))) return 'length';
  switch (e.kind) {
    case 'retry':
    case 'auth':
    case 'resign':
      return null;
    case 'too_big':
      return 'too_big';
    case 'bad_type':
      return 'bad_type';
    case 'upgrade':
      return 'upgrade';
    default:
      return 'denied';
  }
}

/** 依次 PUT 几份（原文件 / 原图在前、缩略图在后），每份退避重试；哪一份不是 ok 就停在那一份、原样交回 */
export async function putParts<P, K>(
  parts: readonly P[],
  put: (x: P) => Promise<UploadResult>,
  failKey: (e: FileError) => K | null,
  retryKey: K,
  sleep: (ms: number) => Promise<void>,
  backoff: readonly number[] = PUT_BACKOFF,
): Promise<'ok' | K | FileError> {
  for (const x of parts) {
    const r = await putWithBackoff(() => put(x), failKey, retryKey, sleep, backoff);
    if (r !== 'ok') return r;
  }
  return 'ok';
}

/**
 * 待传列表：内存里的待传项（带字节等私有字段 X）、给界面的快照（只留公开字段 P）、订阅和提示。
 * pub 从整项里挑出公开字段（快照每次变化重算一次）
 */
export function pendingList<P extends { id: string }, X, N>(pub: (it: P & X) => P) {
  const items = new Map<string, P & X>();
  let snap: readonly P[] = [];
  const subs = new Set<() => void>();
  const noticeSubs = new Set<(n: N) => void>();
  const changed = (): void => {
    snap = [...items.values()].map(pub);
    for (const f of subs) f();
  };
  return {
    items,
    changed,
    notify(n: N): void {
      for (const f of noticeSubs) f(n);
    },
    set(id: string, p: Partial<P & X>): void {
      const it = items.get(id);
      if (!it) return;
      items.set(id, { ...it, ...p });
      changed();
    },
    drop(id: string): void {
      if (items.delete(id)) changed();
    },
    /** 给 hooks 的三件：useSyncExternalStore 的 subscribe、getSnapshot，提示订阅 */
    api: {
      subscribe(fn: () => void): () => void {
        subs.add(fn);
        return () => subs.delete(fn);
      },
      getSnapshot: (): readonly P[] => snap,
      onNotice(fn: (n: N) => void): () => void {
        noticeSubs.add(fn);
        return () => noticeSubs.delete(fn);
      },
    },
  };
}

/** 写行、发送失败区、离开本机这几项默认依赖（两个上传器同一套接法） */
export interface RowUploadDeps extends RowLookup {
  userId(): string | null;
  /** 写行（deps 指向这条随手记）：ok、没写进去（failed），或正在换账号（switching，不提示） */
  insert(row: Record<string, unknown> & { id: string }, noteId: string): Promise<'ok' | 'failed' | 'switching'>;
  /** 这条随手记是不是隐私记（隐私记里不让插图、加附件，安全审建议 5：客户端先拦） */
  isPrivate(noteId: string): boolean;
  /** 这条随手记是不是只读行（带认不出的值，TC-B4-09“写入入口统一拦下”） */
  isReadonly(noteId: string): boolean;
  sid(): string | null;
  exitOf(e: FileError, sid: string | null): Promise<AccountLeaveNotice | 'active' | null>;
  leave(notice: AccountLeaveNotice, sid: string | null): Promise<void>;
  /** 发送失败区里的新建：放弃；返回做成没有 */
  dropFailed(id: string): Promise<boolean>;
  /** 改这一行（软删、撤销）；outbox 拒了回 false */
  patch(id: string, data: Record<string, unknown>): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

const leave = createLeaveAccount();

/** 默认依赖：接到 core 的 write.*、outbox、集合、离开本机，和 platform 的会话 */
export function rowUploadDefaults(table: string): RowUploadDeps {
  return {
    rowExists: (id) => collection(table).get(id) !== undefined,
    userId: () => getBoot()?.userId ?? null,
    async insert(row, noteId) {
      try {
        const r = await write.insert(table, row, { deps: [{ table: 'notes', id: noteId }] });
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
    isPrivate: (noteId) => collection<{ id: string; is_private?: unknown }>('notes').get(noteId)?.['is_private'] === true,
    isReadonly: (noteId) => readonlyIds('notes').getSnapshot().has(noteId),
    sid: () => readSessionId(),
    // accountExitOf 只回探测得出的原因（不会是 expired，那是会话过期，不经这里）；万一是，按被移除走
    async exitOf(e, sid) {
      const r = await accountExitOf(e, sid);
      return r === 'expired' ? 'removed' : r;
    },
    leave,
    async dropFailed(id) {
      return (await resolveFailedCreate(table, id, 'drop')).ok;
    },
    async patch(id, data) {
      try {
        return (await write.patch(table, id, data)).ok;
      } catch (e) {
        if (e instanceof OutboxRejectError) return false;
        throw e;
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
