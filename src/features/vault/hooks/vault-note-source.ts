// 隐私记的数据来源（B5 隐私记重写，主持人 11-15 定稿：notes 出界面、vault 出来源）：隐私记页把它交给 notes 的 NotesSurface，
// 列表、编辑器、电脑分栏、插图、看图页都是随手记那一份（负责人：插图打不开、读写慢）
// • 读：会话的内存仓库（data/vault-store.ts，解锁时 list 一次放进来）；写：只改仓库，界面立刻变，改动交给后台队列（data/vault-queue.ts）去发，
//   不等 vault 函数回来（停笔自动存，没有“保存”按钮）；每次写顺手 touch()（一直在写的人令牌按 5 分钟续一次，M2）
// • 插图：本机压成 webp（同随手记的 platform/image-encode.ts；tz 传 null 不读拍摄时间，S8）→ 图片行放进仓库、本机那一份放进会话的图片表（直接显示）
//   → 队列 save 预登记、经 vault-image 先传原图再传缩略图；没传上的图标“没传上 · 重试”
// • 显示图：会话 image() 取字节做成 blob 地址（只在内存、上锁时撤销，D3）；列表封面只取看得见的（IntersectionObserver，有 el 才看），并发 2 由会话限
// • 附件区：attachments 的 VaultAttachments + 会话的 vault-file 方法（fileApiOf）；服务器上还没有这一条（新建还没存上）时不挂
// • caps：没有 AI、转待办、合并分类、入口行、移进、附件个数；有“移出隐私记”；只读集合一直是空的
// • 运行日志只记动作、结果码、大小，不记标题、正文、图片 id
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { createElement, Suspense } from 'react';
import { uuidv7 } from '../../../core/uuidv7.ts';
import type { EditIo } from '../../../kit/hooks/useEditRecord.ts';
import { encodeDiagText, encodeImage } from '../../../platform/image-encode.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { VaultAttachments, type VaultFileApi, type VaultFileFail } from '../../attachments/index.ts';
import type {
  ImageSrc, InsertResult, NoteAttachmentsProps, NoteImage, NoteImagesApi, NoteRows, NoteSource, NoteSourceText, NoteSync, PendingImage,
} from '../../notes/index.ts';
import type { VaultFail } from '../data/vault-api.ts';
import type { VaultSession } from '../data/session.ts';
import { imageRowOf, type Row, type StoreSnap, type UploadState } from '../data/vault-store.ts';

export { str } from '../data/vault-store.ts';
import { useVault, useVaultStore, vaultSession } from './useVault.ts';

export { useVaultStore } from './useVault.ts';
import { useVaultT } from './useVaultT.ts';

const EMPTY_IDS: ReadonlySet<string> = new Set();
const NO_FILES: readonly Row[] = [];
const NO_IMGS: ImgSel = [];

const fileFail = (r: VaultFail): VaultFileFail => ({ ok: false, code: r.fileCode ?? r.code, ...(r.reason ? { reason: r.reason } : {}) });

/** 会话的 vault-file 方法 → 附件区要的形状（导出给测试） */
export function fileApiOf(s: VaultSession): VaultFileApi {
  return {
    list: async (noteId) => {
      const r = await s.file.list(noteId);
      return r.ok ? { ok: true, files: r.value.files } : fileFail(r);
    },
    upload: async (meta, file, thumb) => {
      const r = await s.file.upload(meta, file, thumb);
      return r.ok ? { ok: true, file: r.value.file } : fileFail(r);
    },
    get: async (id, part) => {
      const r = await s.file.get(id, part);
      return r.ok ? { ok: true, blob: r.value } : fileFail(r);
    },
    remove: async (id) => {
      const r = await s.file.remove(id);
      return r.ok ? { ok: true } : fileFail(r);
    },
    restore: async (id) => {
      const r = await s.file.restore(id);
      return r.ok ? { ok: true } : fileFail(r);
    },
    msPreview: async (id) => {
      const r = await s.file.msPreview(id);
      return r.ok ? { ok: true, url: r.value.url } : fileFail(r);
    },
    msPreviewEnd: () => s.file.msPreviewEnd(),
  };
}

/**
 * 只订仓库里自己要的那一块（M5：打一个字仓库就换一份快照，整份订阅会让每张卡片的图都重算）：
 * 选出来的和上一次 eq 就还回上一次那一份，React 不重渲染
 */
function useStoreSelect<T>(select: (snap: StoreSnap) => T, eq: (a: T, b: T) => boolean = Object.is): T {
  const st = vaultSession().store;
  const last = useRef<{ v: T } | null>(null);
  const get = useCallback((): T => {
    const next = select(st.getSnapshot());
    if (last.current && eq(last.current.v, next)) return last.current.v;
    last.current = { v: next };
    return next;
  }, [st, select, eq]);
  return useSyncExternalStore(st.subscribe, get, get);
}

/** 一条随手记的图片行和各自的上传状态（行是仓库里同一个对象，没改就是同一个引用） */
type ImgSel = readonly (readonly [Row, UploadState | undefined])[];
const sameImgs = (a: ImgSel, b: ImgSel): boolean => a.length === b.length && a.every((x, i) => x[0] === b[i]?.[0] && x[1] === b[i]?.[1]);

/** 元素进没进过视口（没给元素、没有 IntersectionObserver 就当看得见；看见过一次就不再变回去） */
function useSeen(el: RefObject<Element | null> | undefined): boolean {
  const [seen, setSeen] = useState(() => !el || typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const node = el?.current;
    if (seen || !node) return undefined;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) setSeen(true);
    });
    io.observe(node);
    return () => io.disconnect();
  }, [el, seen]);
  return seen;
}

/** 仓库里一条随手记还在的图行和上传状态（插入先后：id 是 uuidv7，按 id 排） */
function imagesOf(snap: StoreSnap, noteId: string): ImgSel {
  const out: [Row, UploadState | undefined][] = [];
  for (const r of snap.images) if (r['note_id'] === noteId && r['deleted_at'] === null) out.push([r, snap.uploads.get(r.id)]);
  return out.sort((a, b) => (a[0].id < b[0].id ? -1 : a[0].id > b[0].id ? 1 : 0));
}

const imageOf = (r: Row, noteId: string): NoteImage => ({
  id: r.id, noteId, path: String(r['path']), hasThumb: r['has_thumb'] === true, width: Number(r['width'] ?? 0), height: Number(r['height'] ?? 0),
});

/** 隐私记的一条（插图、写入都只认 notes 这一张表） */
function noteRowFrom(row: Record<string, unknown> & { id: string }): Row {
  return {
    id: row.id, title: row['title'] ?? '', body: row['body'] ?? '', category_id: row['category_id'] ?? null, sort_key: row['sort_key'] ?? null, category_source: 'manual', category_seen: true,
    is_private: false, converted_to: null, undone: false, created_at: row['created_at'], updated_at: row['updated_at'], deleted_at: null,
  };
}

export function createVaultNoteSource(s: VaultSession, text: NoteSourceText): NoteSource {
  const { store, queue } = s;
  /** 锁着（等解锁、已上锁）不写：仓库已经清了，写进去的会留着明文 */
  const writable = (): boolean => s.hasToken() && s.get().phase === 'unlocked';

  /**
   * 令牌过期上锁、等解锁（waiting）时：编辑页卸下补交的草稿（停笔 800ms 还没到的字，同随手记离开编辑页立即保存）直接交给队列，
   * 不进仓库（锁着仓库是空的）；解锁拉完列表队列合并、盖回、接着发。别的上锁（队列已丢）照旧拒
   */
  const waiting = (): boolean => s.get().waiting;

  const editIo: EditIo = {
    useRow(_table, id) {
      const snap = useVaultStore();
      return useMemo(() => (id === null ? undefined : snap.notes.find((n) => n.id === id)), [snap, id]);
    },
    useReadonly: () => EMPTY_IDS,
    async insert(_table, row) {
      const r = noteRowFrom(row);
      if (!writable()) {
        if (!waiting()) return 'rejected';
        queue.wrote(r, true);
        return 'saved';
      }
      store.put(r);
      queue.wrote(r, true);
      s.touch();
      return 'saved';
    },
    async patch(_table, id, data) {
      if (!writable()) {
        if (!waiting()) return 'rejected';
        queue.patched(id, data);
        return 'saved';
      }
      const r = store.patch(id, data);
      if (!r) return 'rejected';
      // 交改了哪几列（R-429）：只拖了顺序时 save 带 base_updated_at、没改排序值时不带 sort_key（vault-queue.ts 文件头）
      queue.wrote(r, false, Object.keys(data));
      s.touch();
      return 'saved';
    },
    async setDeleted(_table, id, deleted, now) {
      if (!writable()) return 'rejected';
      const r = store.patch(id, { deleted_at: deleted ? now : null, updated_at: now });
      if (!r) return 'rejected';
      queue.deleted(r, deleted);
      return 'saved';
    },
  };

  /** 插一张图：压图 → 图片行、本机那一份 → 队列；note 是函数时压成了才新建 */
  async function insert(note: string | (() => Promise<string | null>), file: File): Promise<InsertResult> {
    if (!writable()) return { ok: false, code: 'silent' };
    const enc = await encodeImage(file, null);
    const diag = enc.diag ? ` ${encodeDiagText(enc.diag)}` : '';
    rlog(enc.ok ? `vault img encode ok kb=${Math.round(enc.full.size / 1024)} ${enc.width}x${enc.height}${diag}` : `vault img encode ${enc.code}${diag}`);
    if (!enc.ok) return { ok: false, code: enc.code };
    const noteId = typeof note === 'string' ? note : await note();
    const row = noteId === null ? undefined : store.get(noteId);
    if (noteId === null || !row || !writable()) return { ok: false, code: 'silent' };
    const id = uuidv7(Date.now());
    s.seedImage(id, enc.full, enc.thumb);
    // has_thumb 跟交给队列的缩略图走（L3：和 add_images 预登记的同一个判断）
    store.putImage(imageRowOf(noteId, { id, has_thumb: enc.thumb !== null, width: enc.width, height: enc.height, bytes: enc.full.size, deleted_at: null }));
    queue.addImage(row, { id, full: enc.full, thumb: enc.thumb, width: enc.width, height: enc.height });
    return { ok: true, id };
  }

  function VaultFiles({ noteId, disabled }: NoteAttachmentsProps) {
    const snap = useVaultStore();
    const api = useMemo(() => fileApiOf(s), []);
    // 服务器上还没有这一条（新建、第一次 save 还没成）：vault-file 会回 not_found，先不挂
    if (noteId === null || snap.fresh.has(noteId)) return null;
    return createElement(Suspense, { fallback: null }, createElement(VaultAttachments, { noteId, api, disabled }));
  }

  return {
    kind: 'vault',
    caps: { ai: false, convert: false, merge: false, lockrow: false, moveIn: false, moveOut: true, filesMark: false, search: false, trashLink: true },
    route: { list: 'vault', edit: 'vault' },
    desk: 'vault',
    orderKey: 'vault.order',
    trash: ['vault', 'trash'],
    useTrashCount: () => useVaultStore().notes.filter((n) => n['deleted_at'] !== null).length,
    text,
    useRows(): NoteRows {
      const snap = useVaultStore();
      return useMemo(() => ({ notes: snap.notes, images: snap.images, files: NO_FILES }), [snap]);
    },
    useReadonly: () => EMPTY_IDS,
    editIo,
    async discard(id) {
      if (queue.discard(id)) {
        store.forget([id]);
        return 'saved';
      }
      return editIo.setDeleted('notes', id, true, Date.now(), false);
    },
    useImages(noteId): NoteImagesApi {
      const pick = useCallback((snap: StoreSnap): ImgSel => (noteId === null ? NO_IMGS : imagesOf(snap, noteId)), [noteId]);
      const sel = useStoreSelect(pick, sameImgs);
      return useMemo(() => {
        const items = sel.map(([r, up]) => {
          const img = imageOf(r, String(noteId));
          const pending: PendingImage | null = up
            ? { id: img.id, noteId: img.noteId, path: img.path, url: s.peekImage(img.id, 'full') ?? '', state: up, fail: up === 'failed' ? 'retry' : null }
            : null;
          return { img, pending };
        });
        return {
          items,
          insert: (file: File) => (noteId === null ? Promise.resolve<InsertResult>({ ok: false, code: 'silent' }) : insert(noteId, file)),
          async remove(id: string) {
            const im = store.getImage(id);
            const row = im ? store.get(String(im['note_id'])) : undefined;
            if (!row || !writable()) return false;
            store.patchImage(id, { deleted_at: Date.now() });
            queue.removeImage(row, id);
            s.revokeImages([id]);
            return true;
          },
          retry: (id: string) => queue.retryImage(id),
        };
      }, [sel, noteId]);
    },
    useImageSrc(img, thumb, el): ImageSrc {
      const id = img?.id ?? null;
      const pickFailed = useCallback((snap: StoreSnap): boolean => id !== null && snap.uploads.get(id) === 'failed', [id]);
      const failed = useStoreSelect(pickFailed);
      const { state } = useVault();
      const seen = useSeen(el);
      const part = thumb && img?.hasThumb ? 'thumb' : 'full';
      const have = id === null ? null : s.peekImage(id, part);
      const [got, setGot] = useState<{ key: string; url: string | null } | null>(null);
      const key = `${id}:${part}`;
      const unlocked = state.phase === 'unlocked';
      useEffect(() => {
        if (id === null || have || !seen || !unlocked) return undefined;
        let live = true;
        void s.image(id, part).then((url) => {
          if (live) setGot({ key, url });
        });
        return () => {
          live = false;
        };
      }, [id, part, have, seen, unlocked, key]);
      return { url: have ?? (got?.key === key ? got.url : null), missing: false, failed };
    },
    insertImage: insert,
    onNotice: () => () => undefined,
    Attachments: VaultFiles,
    async moveOut(id) {
      const r = await s.exportNote(id);
      return r.ok ? 'ok' : 'failed';
    },
    useSync(): NoteSync {
      const snap = useVaultStore();
      return useMemo(() => ({ failed: snap.failed, dropped: snap.dropped, stale: snap.stale, retry: (id: string) => queue.retry(id), ack: () => store.ackDropped(), ackStale: () => store.ackStale() }), [snap]);
    },
  };
}

/** 隐私记页用的来源（会话一份、文案换语言时重建）；backMark：编辑页返回旁的小锁（界面层给，hooks 不引 ui），传模块级常量 */
export function useVaultNoteSource(backMark: ReactNode = null): NoteSource {
  const t = useVaultT();
  const { s } = useVault();
  const title = t('vault.title', {});
  const empty = t('vault.empty', {});
  const trash = t('vault.trash', {});
  return useMemo(() => createVaultNoteSource(s, { title, empty, back: title, backMark, trash }), [s, title, empty, trash, backMark]);
}
