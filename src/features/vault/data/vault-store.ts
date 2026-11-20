// 隐私记的内存仓库（B5 隐私记重写，主持人 11-15 定稿：随手记界面 + 隐私记来源；负责人“读取跟写入速度太慢了，优化到跟随手记一样”）
// • 会话持有（data/session.ts）：解锁时 list 一次全量放进来（不带图片字节），之后读只读这里、写只改这里，界面立刻变；
//   要发给服务器的改动交给 ./vault-queue.ts 在后台串行发，不再每次读写都同步等 vault 函数
// • 行的形状照本机集合（notes、note_images），随手记界面的纯函数（note-list.ts 的 noteItems、imagesByNote，note-edit.ts 的 formOf、patchOf）原样用：
//   隐私记行 is_private 写 false（这里只有隐私记，不靠它筛）、category_source 写 'manual'（没有 AI 分类）；图片行的 path 是占位（隐私记的图按 id 经 vault-image 取）
// • 上锁就清空（明文不留，TC-B5-11）；“有 N 处改动没来得及保存”的个数（dropped）不随上锁清，看过了才清（只记个数，不带内容）
// • failed：发了几次都没成的条目（列表行、编辑页标“没保存上”）；uploads：还在传、没传上的图；
//   fresh：本机新建、服务器上还没有的条目（第一次 save 成了才去掉；附件区等它，vault-file 要这一条已经在服务器上）
// • known：上一段解锁期里知道的、还活着的隐私记 id（只有 id，不带内容）。上锁清明文时留下它，锁着时数“里面有 N 条”用（countVault）：
//   隐私记的写入只走 vault 函数、不进本机 notes 集合（session.ts、vault-queue.ts 不碰 core/cache），本机集合要等同步拉回来才有那一行；
//   刚记的、刚移进来的、还在后台队列里的，锁上后原来数不到，卡片写“里面有 0 条”（R-436 丁批审查）
// • 不碰 core/cache、outbox、log（A18）；纯 TS，不准 import React（A1）
import { createSignal } from '../../../../shared/core/signal.ts';
import { isLiveRow } from '../../../../shared/logic/live-row.ts';
import type { VaultNote } from '../../../../shared/schema/vault.ts';

export type Row = { id: string } & Record<string, unknown>;
export type UploadState = 'uploading' | 'failed';

export interface StoreSnap {
  notes: readonly Row[];
  images: readonly Row[];
  failed: ReadonlySet<string>;
  uploads: ReadonlyMap<string, UploadState>;
  fresh: ReadonlySet<string>;
  dropped: number;
  /** 只拖了顺序、服务器回 stale（别处刚改过）没移动的条数（R-429）；看过才清 */
  stale: number;
  /** 上锁前知道的活着的隐私记 id（见文件头 known）；解锁拉过列表以后不用它 */
  known: ReadonlySet<string>;
}

/** 本机 notes 集合里的一行（隐私记行只有中性列，0.27 第 1 点） */
export type LocalNoteRow = { id: string; is_private?: unknown; deleted_at?: unknown; undone?: unknown };

/**
 * 隐私记有几条（锁着也能数，不碰明文）：
 * • 这一段解锁期拉过列表（listed）：以内存仓库为准；
 * • 没拉过（锁着）：本机集合里活着的隐私记行，并上上锁前知道的（known，同步还没拉回来的），本机集合里已经删了、撤销了的不算
 */
export function countVault(local: readonly LocalNoteRow[], listed: boolean, snap: StoreSnap): number {
  if (listed) return snap.notes.filter((n) => n['deleted_at'] == null).length;
  const ids = new Set(snap.known);
  for (const r of local) {
    if (r.is_private !== true) continue;
    if (isLiveRow(r)) ids.add(r.id);
    else ids.delete(r.id);
  }
  return ids.size;
}

/** 行里的字符串字段（不是字符串就当空；队列发 save、回收站显示标题共用这一份） */
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 隐私记的一条 → 随手记集合那种行 */
export function noteRowOf(n: VaultNote): Row {
  return {
    id: n.id, title: n.title, body: n.body, category_id: n.category_id, sort_key: n.sort_key ?? null, category_source: 'manual', category_seen: true, is_private: false,
    converted_to: null, undone: false, created_at: n.created_at, updated_at: n.updated_at, deleted_at: n.deleted_at,
  };
}

/** 隐私记的一张图 → note_images 那种行（path 只是占位，界面按 id 取图） */
export function imageRowOf(noteId: string, im: { id: string; has_thumb: boolean; width: number | null; height: number | null; bytes: number; deleted_at: number | null }): Row {
  return { id: im.id, note_id: noteId, bucket: 'images', path: `vault/${noteId}/${im.id}`, has_thumb: im.has_thumb, width: im.width, height: im.height, bytes: im.bytes, deleted_at: im.deleted_at };
}

export function createVaultStore() {
  let notes = new Map<string, Row>();
  let images = new Map<string, Row>();
  let failed: ReadonlySet<string> = new Set();
  let uploads: ReadonlyMap<string, UploadState> = new Map();
  let fresh: ReadonlySet<string> = new Set();
  let dropped = 0;
  let stale = 0;
  let known: ReadonlySet<string> = new Set();
  /** 拉过全量列表（load）：上锁时 notes 就是全部，known 整个换成它；没拉过只把仓库里有的并进去 */
  let loaded = false;
  let snap: StoreSnap | null = null;
  const listeners = createSignal();

  const changed = (): void => {
    snap = null;
    listeners.emit();
  };
  /** 集合里加、减一个 id（没变回原来那个） */
  const toggled = (set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> => {
    if (set.has(id) === on) return set;
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };

  return {
    getSnapshot(): StoreSnap {
      snap ??= { notes: [...notes.values()], images: [...images.values()], failed, uploads, fresh, dropped, stale, known };
      return snap;
    },
    subscribe: listeners.subscribe,
    /** 解锁后的全量列表（替换掉原来的） */
    load(list: readonly VaultNote[]): void {
      notes = new Map(list.map((n) => [n.id, noteRowOf(n)]));
      images = new Map(list.flatMap((n) => n.images.map((im) => [im.id, imageRowOf(n.id, im)] as const)));
      loaded = true;
      changed();
    },
    /** 上锁：明文、图片行、状态全清（dropped 留着，解锁后报一句） */
    clear(): void {
      // 明文清掉之前先记下活着的 id（只留 id）：锁着时“里面有 N 条”照样数得到同步还没拉回来的
      const live = [...notes.values()].filter((n) => n['deleted_at'] == null).map((n) => n.id);
      const dead = [...notes.values()].filter((n) => n['deleted_at'] != null).map((n) => n.id);
      const next = new Set(loaded ? live : [...known, ...live]);
      for (const id of dead) next.delete(id);
      known = next;
      loaded = false;
      notes = new Map();
      images = new Map();
      failed = new Set();
      uploads = new Map();
      fresh = new Set();
      changed();
    },
    get: (id: string): Row | undefined => notes.get(id),
    getImage: (id: string): Row | undefined => images.get(id),
    /** 整行放进来（新建、或队列把本机改过的那一份盖回来） */
    put(row: Row): void {
      notes = new Map(notes).set(row.id, row);
      changed();
    },
    /** 改几列；回改完的整行（没有这一条回 undefined） */
    patch(id: string, data: Record<string, unknown>): Row | undefined {
      const cur = notes.get(id);
      if (!cur) return undefined;
      const next = { ...cur, ...data, id };
      notes = new Map(notes).set(id, next);
      changed();
      return next;
    },
    /** 这一条不在隐私记里了（移出、永久删除、新建了又撤销） */
    forget(ids: readonly string[]): void {
      notes = new Map(notes);
      images = new Map(images);
      for (const id of ids) notes.delete(id);
      if (ids.some((id) => known.has(id))) known = new Set([...known].filter((id) => !ids.includes(id)));
      for (const [k, r] of images) if (ids.includes(String(r['note_id']))) images.delete(k);
      changed();
    },
    putImage(row: Row): void {
      images = new Map(images).set(row.id, row);
      changed();
    },
    patchImage(id: string, data: Record<string, unknown>): void {
      const cur = images.get(id);
      if (!cur) return;
      images = new Map(images).set(id, { ...cur, ...data, id });
      changed();
    },
    dropImage(id: string): void {
      images = new Map(images);
      images.delete(id);
      changed();
    },
    setFailed(id: string, on: boolean): void {
      const next = toggled(failed, id, on);
      if (next === failed) return;
      failed = next;
      changed();
    },
    setFresh(id: string, on: boolean): void {
      const next = toggled(fresh, id, on);
      if (next === fresh) return;
      fresh = next;
      changed();
    },
    setUpload(id: string, state: UploadState | null): void {
      if ((uploads.get(id) ?? null) === state) return;
      const next = new Map(uploads);
      if (state) next.set(id, state);
      else next.delete(id);
      uploads = next;
      changed();
    },
    addDropped(n: number): void {
      if (n <= 0) return;
      dropped += n;
      changed();
    },
    ackDropped(): void {
      if (dropped === 0) return;
      dropped = 0;
      changed();
    },
    addStale(): void {
      stale += 1;
      changed();
    },
    ackStale(): void {
      if (stale === 0) return;
      stale = 0;
      changed();
    },
  };
}

export type VaultStore = ReturnType<typeof createVaultStore>;
