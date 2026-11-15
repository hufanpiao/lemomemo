// 隐私记的后台发送队列（B5 隐私记重写，主持人 11-15 定稿）：写只改内存仓库（./vault-store.ts），改动排在这里按条串行发给 vault / vault-image
// • 按条合并：同一条随手记的改动并成一份（job），发之前读这一份最新的行（发前读最新值），发出去以后又改了就再发一次
// • 一条的顺序：save（带 add_images 预登记还没登记的图、remove_images）→ 每张图 vault-image 先传原图再传缩略图 → delete / undelete
// • 同一条两次 save 至少隔 SAVE_GAP_MS（1.5 秒）：编辑页停笔 800ms 存一次，连着打字不会每 0.8 秒打一次服务器（每人每分钟 60 次）
// • 退避、间隔都记在每一条自己的 nextAt 上（M4）：没到点的跳过、先发别的条；都没到点就睡到最早那一条，重试、新改动提前叫醒
// • 失败只按 vault-errors.ts 的落法（kind）分：
//   - retry（offline、try_later、rate_limited）：2 秒、5 秒、15 秒退避 3 次，还不行标 failed（列表行、编辑页“没保存上 · 重试”），online 事件再试
//   - unlock（vault_locked，含上锁以后才回来的 STALE）：会话已经上锁、暂停了队列（pause）；这一条原样留着，解锁后 resume 整条重发
//   - relock、revoked：会话已经上锁、整个队列丢掉了（这里兜一下）；message（not_found、bad_request、too_large……）：标 failed，不自动重试
// • 上锁（session.ts 的 lock）：令牌过期那种 pause()——不发、不丢，锁着时编辑页卸下补交的改动 patched() 先记下来（只有改了的字段），
//   解锁拉完列表 overlay() 合并到拉来的那一行、盖回仓库，resume() 接着发；
//   别的上锁调 dropAll()：全部丢掉、个数记进仓库（解锁后报“有 N 处改动没来得及保存”），运行日志 vault queue drop n=（不带内容）
// • 运行日志不记标题、正文、图片 id，只记动作、结果码、次数
// • 不碰 core/cache、outbox、log（A18）；纯 TS，不准 import React（A1）
import type { VaultImageAdd } from '../../../../shared/schema/vault.ts';
import type { VaultResult } from './vault-api.ts';
import { vaultErrorAction, type VaultCode } from './vault-errors.ts';
import { imageRowOf, type Row, type VaultStore } from './vault-store.ts';

export const QUEUE_BACKOFF = [2000, 5000, 15000] as const;
export const SAVE_GAP_MS = 1500;

export interface SaveReq {
  id: string;
  title: string;
  body: string;
  category_id: string | null;
  created_at: number;
  updated_at: number;
  add_images?: VaultImageAdd[];
  remove_images?: string[];
}

export interface QueueDeps {
  store: VaultStore;
  save(req: SaveReq): Promise<VaultResult<unknown>>;
  setDeleted(id: string, deleted: boolean): Promise<VaultResult<unknown>>;
  upload(noteId: string, imageId: string, part: 'full' | 'thumb', blob: Blob): Promise<VaultResult<unknown>>;
  /** 本机那一份图放进会话的图片表（做成 blob 地址，上锁时撤销）：解锁后 overlay 时补一次 */
  seed(imageId: string, full: Blob, thumb: Blob | null): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

/** 一张待传的图：字节只在内存里 */
export interface QueuedImage {
  id: string;
  full: Blob;
  thumb: Blob | null;
  width: number;
  height: number;
}

interface PendingPic extends QueuedImage {
  registered: boolean;
  done: { full: boolean; thumb: boolean };
}

interface Job {
  id: string;
  /** 本机最新的一份行（发前读它；令牌过期上锁时仓库清了，靠它盖回去） */
  row: Row;
  /** 内容每改一次加 1：发出去以后又改了就不算发完 */
  v: number;
  dirty: boolean;
  /** 要发的删除 / 撤销删除；null = 没有 */
  del: boolean | null;
  adds: Map<string, PendingPic>;
  removes: Set<string>;
  /** 服务器上已经有这一条 */
  known: boolean;
  /** 锁着时记下的改动（row 只有改了的字段）：overlay 合并成整行以前不发 */
  partial: boolean;
  lastSave: number;
  /** 这个时刻以前不发（退避、两次 save 的间隔；M4：每条自己记，不让别的条跟着等） */
  nextAt: number;
  tries: number;
  failed: boolean;
  waiters: ((ok: boolean) => void)[];
}

/** 同时最多跑 n 个（取图用） */
export function limiter(n: number) {
  let busy = 0;
  const wait: (() => void)[] = [];
  return async <T,>(job: () => Promise<T>): Promise<T> => {
    if (busy >= n) await new Promise<void>((r) => wait.push(r));
    busy += 1;
    try {
      return await job();
    } finally {
      busy -= 1;
      wait.shift()?.();
    }
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function createVaultQueue(d: QueueDeps) {
  const jobs = new Map<string, Job>();
  let running = false;
  /** 令牌过期上锁期间：不发 */
  let paused = false;
  /** 正在移出隐私记的几条：改动照收，但不发（移出成了整条 forget，H5） */
  const holds = new Set<string>();
  /** 正在发的那一条（discard 不能拿掉它：请求已经在路上） */
  let current: string | null = null;
  /** dropAll 一次加 1：在飞的那一次回来发现变了就什么都不做 */
  let gen = 0;

  const jobOf = (row: Row, known: boolean): Job => {
    let j = jobs.get(row.id);
    if (!j) {
      j = { id: row.id, row, v: 0, dirty: false, del: null, adds: new Map(), removes: new Set(), known, partial: false, lastSave: 0, nextAt: 0, tries: 0, failed: false, waiters: [] };
      jobs.set(row.id, j);
    }
    j.row = j.partial ? { ...j.row, ...row } : row;
    return j;
  };

  function finish(j: Job, ok: boolean): void {
    if (ok) {
      jobs.delete(j.id);
      d.store.setFailed(j.id, false);
    }
    const ws = j.waiters;
    j.waiters = [];
    for (const w of ws) w(ok);
  }

  function dropAll(why: string): number {
    const n = jobs.size;
    gen += 1;
    const all = [...jobs.values()];
    jobs.clear();
    for (const j of all) {
      if (!j.known) d.store.setFresh(j.id, false);
      finish(j, false);
    }
    if (n > 0) {
      d.log(`vault queue drop n=${n} why=${why}`);
      d.store.addDropped(n);
    }
    return n;
  }

  async function fail(j: Job, code: VaultCode, imageId: string | null): Promise<void> {
    const kind = vaultErrorAction(code).kind;
    d.log(`vault queue fail ${code}${imageId ? ' img' : ''} try=${j.tries}`);
    // 会话上锁时已经 pause：原样留着等 resume（没暂停的 vault_locked 不会有，万一有就落成 failed，不空转）
    if (kind === 'unlock' && paused) return;
    if (kind === 'relock' || kind === 'revoked') {
      dropAll(kind);
      return;
    }
    const wait = kind === 'retry' ? QUEUE_BACKOFF[j.tries] : undefined;
    if (wait !== undefined) {
      j.tries += 1;
      j.nextAt = d.now() + wait;
      return;
    }
    j.failed = true;
    j.tries = 0;
    d.store.setFailed(j.id, true);
    if (imageId) d.store.setUpload(imageId, 'failed');
    finish(j, false);
  }

  /** 发一条的一轮；回来以后 loop 再看它发完没有 */
  async function step(j: Job): Promise<void> {
    const g = gen;
    const alive = (): boolean => g === gen && jobs.get(j.id) === j;
    const adds = [...j.adds.values()].filter((a) => !a.registered);
    const removes = [...j.removes];
    if (j.dirty || adds.length > 0 || removes.length > 0) {
      const v = j.v;
      const row = j.row;
      const now = d.now();
      const r = await d.save({
        id: j.id, title: str(row['title']).trim(), body: str(row['body']),
        category_id: typeof row['category_id'] === 'string' ? row['category_id'] : null,
        created_at: num(row['created_at'], now), updated_at: num(row['updated_at'], now),
        ...(adds.length ? { add_images: adds.map((a) => ({ id: a.id, bytes: a.full.size, width: a.width || null, height: a.height || null, has_thumb: a.thumb !== null })) } : {}),
        ...(removes.length ? { remove_images: removes } : {}),
      });
      if (!alive()) return;
      if (!r.ok) return fail(j, r.code, null);
      if (!j.known) d.store.setFresh(j.id, false);
      j.known = true;
      j.lastSave = d.now();
      // 下一次 save 至少隔 SAVE_GAP_MS（这一轮接着传图、删除不受影响）
      j.nextAt = j.lastSave + SAVE_GAP_MS;
      j.tries = 0;
      // 这次 save 预登记了的图、在路上时被删掉的（H3）：服务器上已经登记了，下次 save 带 remove_images 删掉
      for (const a of adds) {
        if (j.adds.get(a.id) === a) a.registered = true;
        else j.removes.add(a.id);
      }
      for (const x of removes) j.removes.delete(x);
      if (j.v === v) j.dirty = false;
    }
    for (const a of [...j.adds.values()]) {
      if (!a.registered) continue;
      for (const part of ['full', 'thumb'] as const) {
        const blob = part === 'full' ? a.full : a.thumb;
        if (!blob || a.done[part] || !j.adds.has(a.id)) continue;
        const r = await d.upload(j.id, a.id, part, blob);
        if (!alive()) return;
        if (!r.ok) return fail(j, r.code, a.id);
        a.done[part] = true;
        j.tries = 0;
      }
      if (j.adds.delete(a.id)) d.store.setUpload(a.id, null);
    }
    if (j.del !== null) {
      const want = j.del;
      const r = await d.setDeleted(j.id, want);
      if (!alive()) return;
      if (!r.ok) return fail(j, r.code, null);
      j.tries = 0;
      if (j.del === want) j.del = null;
    }
    if (!j.dirty && j.adds.size === 0 && j.removes.size === 0 && j.del === null) finish(j, true);
  }

  async function loop(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (!paused) {
        const ready = [...jobs.values()].filter((x) => !x.failed && !x.partial && !holds.has(x.id));
        if (ready.length === 0) break;
        const at = d.now();
        const j = ready.find((x) => x.nextAt <= at);
        if (!j) {
          // 都还没到点：睡到最早那一条；重试、新改动（kick）提前叫醒。睡够了就算到点（计时器早几毫秒、测试里不走的钟都不空转）
          const due = Math.min(...ready.map((x) => x.nextAt));
          const woke = await Promise.race([d.sleep(due - at).then(() => false), new Promise<boolean>((r) => (wake = () => r(true)))]);
          wake = null;
          if (!woke) for (const x of ready) if (x.nextAt <= due) x.nextAt = 0;
          continue;
        }
        current = j.id;
        await step(j);
        current = null;
      }
    } finally {
      running = false;
      current = null;
      wake = null;
    }
  }
  let wake: (() => void) | null = null;
  const kick = (): void => {
    if (wake) wake();
    else void loop();
  };

  const unfail = (j: Job): void => {
    j.failed = false;
    j.tries = 0;
    j.nextAt = 0;
    d.store.setFailed(j.id, false);
    for (const a of j.adds.values()) d.store.setUpload(a.id, 'uploading');
  };

  return {
    /** 新建或改了内容（isNew：本机刚建的，服务器上还没有） */
    wrote(row: Row, isNew: boolean): void {
      const j = jobOf(row, !isNew);
      if (!j.known) d.store.setFresh(j.id, true);
      j.dirty = true;
      j.v += 1;
      kick();
    },
    /** 锁着（令牌过期、仓库已清）时编辑页卸下补交的改动：只记改了的字段，解锁拉完列表 overlay 合并成整行再发 */
    patched(id: string, data: Record<string, unknown>): void {
      const j = jobs.get(id) ?? Object.assign(jobOf({ id }, true), { partial: true });
      j.row = { ...j.row, ...data, id };
      j.dirty = true;
      j.v += 1;
    },
    /** 移出隐私记在路上：这一条先不发（release 放开；移出成了调用方 forget） */
    hold(id: string): void {
      holds.add(id);
    },
    release(id: string): void {
      holds.delete(id);
      kick();
    },
    /** 令牌过期上锁：停下（不丢）；解锁后 resume */
    pause(): void {
      paused = true;
    },
    resume(): void {
      paused = false;
      kick();
    },
    /** 删除、撤销删除 */
    deleted(row: Row, deleted: boolean): void {
      jobOf(row, true).del = deleted;
      kick();
    },
    /** 插一张图（行已经在仓库里）：仓库里多一张“上传中”，字节等着传 */
    addImage(row: Row, img: QueuedImage): void {
      const j = jobOf(row, jobs.get(row.id)?.known ?? true);
      j.adds.set(img.id, { ...img, registered: false, done: { full: false, thumb: false } });
      d.store.setUpload(img.id, 'uploading');
      kick();
    },
    /** 删一张图：还没登记的就地丢掉，登记过的、本来就有的下次 save 带 remove_images */
    removeImage(row: Row, imageId: string): void {
      const j = jobOf(row, jobs.get(row.id)?.known ?? true);
      const a = j.adds.get(imageId);
      j.adds.delete(imageId);
      d.store.setUpload(imageId, null);
      if (!a || a.registered) j.removes.add(imageId);
      kick();
    },
    /** 撤销刚新建、还没发出去的一条：成了回 true（调用方从仓库拿掉）；已经发过、正在发的回 false（调用方改成删除） */
    discard(id: string): boolean {
      const j = jobs.get(id);
      if (!j || j.known || j.lastSave > 0 || current === id) return false;
      jobs.delete(id);
      d.store.setFresh(id, false);
      finish(j, false);
      return true;
    },
    /** 永久删除成了：这几条排着的、正在发的都撤掉（在飞的那一次回来 alive() 不成立、什么都不做），连同没保存上、新建、上传中的标记 */
    forget(ids: readonly string[]): void {
      for (const id of ids) {
        const j = jobs.get(id);
        if (!j) continue;
        jobs.delete(id);
        for (const a of j.adds.keys()) d.store.setUpload(a, null);
        d.store.setFresh(id, false);
        d.store.setFailed(id, false);
        finish(j, false);
      }
    },
    /** “没保存上 · 重试” */
    retry(id: string): void {
      const j = jobs.get(id);
      if (j && (j.failed || j.tries > 0)) unfail(j);
      kick();
    },
    /** 网络回来了（online）：没保存上的、正在退避的都立即再试（两次 save 的间隔照旧） */
    retryAll(): void {
      for (const j of jobs.values()) if (j.failed || j.tries > 0) unfail(j);
      kick();
    },
    /** 一张没传上的图再传一次；字节不在内存里回 false（界面让用户重新选一张） */
    retryImage(imageId: string): boolean {
      const j = [...jobs.values()].find((x) => x.adds.has(imageId));
      if (!j) return false;
      unfail(j);
      kick();
      return true;
    },
    /** 等这一条发完（移出隐私记之前）；没有排着的回 true，丢掉、没保存上回 false */
    flush(id: string): Promise<boolean> {
      const j = jobs.get(id);
      if (!j) return Promise.resolve(true);
      if (j.failed) unfail(j);
      kick();
      return new Promise<boolean>((resolve) => j.waiters.push(resolve));
    },
    /** 解锁拉完列表以后：本机还没发完的那一份盖回仓库（行、待传的图、要删的图、没保存上的标记） */
    overlay(): void {
      for (const j of [...jobs.values()]) {
        if (j.partial) {
          // 锁着时记下的改动：合并到拉来的那一行；服务器上已经没有这一条（别处永久删了）就丢掉
          const base = d.store.get(j.id);
          if (!base) {
            jobs.delete(j.id);
            continue;
          }
          j.row = { ...base, ...j.row };
          j.partial = false;
        }
        d.store.put(j.row);
        for (const a of j.adds.values()) {
          d.store.putImage(imageRowOf(j.id, { id: a.id, has_thumb: a.thumb !== null, width: a.width, height: a.height, bytes: a.full.size, deleted_at: null }));
          d.store.setUpload(a.id, j.failed ? 'failed' : 'uploading');
          d.seed(a.id, a.full, a.thumb);
        }
        for (const x of j.removes) d.store.patchImage(x, { deleted_at: d.now() });
        if (j.failed) d.store.setFailed(j.id, true);
        if (!j.known) d.store.setFresh(j.id, true);
      }
      kick();
    },
    dropAll,
    has: (id: string): boolean => jobs.has(id),
    size: (): number => jobs.size,
  };
}

export type VaultQueue = ReturnType<typeof createVaultQueue>;
