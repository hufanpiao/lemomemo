// 随手记插图页面测试的公用搭法（NoteImages.test.tsx、NoteImages-review.test.tsx 共用）：真实冷启动（假 IndexedDB），只换掉编码、上传、签名取字节
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { coldStart, getBoot, resetBootForTest } from '../../../core/boot.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import type { ServerRow } from '../../../core/cache.ts';
import { clearAllCollections } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import type { UploadResult } from '../../../platform/files.ts';
import type { EncodeResult } from '../../../platform/image-encode.ts';
import { createUploader, defaultUploaderDeps, resetUploaderForTest } from '../data/image-uploader.ts';
import { createImageView, resetImageViewForTest } from '../data/image-view.ts';
import NotesPage from '../ui/NotesPage.tsx';

export const NOW = msAt('2026-11-10', 20 * 60, 'Asia/Seoul');
export const USER = '00000000-0000-4000-8000-0000000000aa';
export const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export type Row = { id: string } & Record<string, unknown>;

export async function boot() {
  const { factory } = fakeIndexedDB();
  const b = await coldStart({
    userId: USER, appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
  b.profile = { ...(b.profile ?? {}), current_tz: 'Asia/Seoul' } as NonNullable<typeof b.profile>;
  return b;
}
export const serverNote = (n: number): ServerRow =>
  ({
    id: uid(n), title: null, body: `第${n}条`, is_private: false, category_id: null, category_source: 'none', category_seen: true, ai_status: 'done',
    tags: [], converted_to: null, source: 'page', raw_text: '', batch_id: null, deleted_at: null, undone: false,
    created_at: msAt('2026-11-10', 9 * 60 + n, 'Asia/Seoul'), updated_at: 1, rev: 2,
  }) as ServerRow;
export const serverImage = (id: string, note: string): ServerRow =>
  ({ id, note_id: note, bucket: 'images', path: `${USER}/${note}/${id}.webp`, bytes: 10, width: 16, height: 10, mime: 'image/webp', taken_at: null, has_thumb: true, deleted_at: null, undone: false, rev: 1 }) as ServerRow;

export const okEnc = (): Promise<EncodeResult> =>
  Promise.resolve({ ok: true, full: new Blob([new Uint8Array(7)], { type: 'image/webp' }), thumb: new Blob([new Uint8Array(3)], { type: 'image/webp' }), width: 16, height: 10, takenAt: null });

/** 换掉编码、上传、显示；别的照真的走 */
export function wire(o: { encode?: () => Promise<EncodeResult>; upload?: (path: string) => Promise<UploadResult>; missing?: boolean | (() => boolean); insertFails?: boolean } = {}) {
  const view = createImageView({
    sign: (items) => Promise.resolve(items.map((x) => ({ ok: true as const, url: `https://lemo.test/files/v1/o/images/${x.path}`, sig: 's', expiresAt: 1 }))),
    fetchBlob: () => Promise.resolve((typeof o.missing === 'function' ? o.missing() : o.missing) ? { ok: false as const, kind: 'denied' as const, code: 'not_found', status: 404 } : { ok: true as const, blob: new Blob(), contentType: 'image/webp' }),
    objectUrl: () => 'blob:remote',
    revoke: () => undefined,
  });
  resetImageViewForTest(view);
  const upload = vi.fn(o.upload ?? (() => Promise.resolve<UploadResult>({ ok: true, etag: null, existed: false })));
  const base = defaultUploaderDeps();
  resetUploaderForTest(createUploader({ ...base, insert: o.insertFails ? () => Promise.resolve('failed' as const) : base.insert, encode: o.encode ?? okEnc, upload, objectUrl: () => 'blob:local', revoke: vi.fn(), sleep: () => Promise.resolve(), view, pollMs: 10 }));
  return { upload };
}

/** 模拟同步引擎把队首一项发出去：成功或按 code 失败 */
export async function sendNext(code?: string) {
  const o = getBoot()?.outbox;
  if (!o) throw new Error('no_outbox');
  const it = await o.next();
  if (!it) throw new Error('queue_empty');
  if (code) await o.fail(it.op_id, { status: 400, code, sid: null });
  else await o.ack(it.op_id, { status: 'ok', rev: 1, prev_rev: it.op === 'insert' ? null : 0 });
  return it;
}

export const pick = (testId: string, f: File) => fireEvent.change(screen.getByTestId(testId), { target: { files: [f] } });
/** 随手记输入行点“记下”（R-416：选了图先挂着，记下才存） */
export const remember = () => fireEvent.submit(screen.getByTestId('notes-input-row'));
export const jpg = () => new File([new Uint8Array(5)], 'a.jpg', { type: 'image/jpeg' });

export function open(hash = '#/notes') {
  window.history.replaceState(null, '', `/app/${hash}`);
  return render(<NotesPage />);
}

/** 每个用例前后：清集合、中文、固定时间；收尾拆掉上传器、显示层和冷启动 */
export function setupImageTests(): void {
  beforeEach(() => {
    clearAllCollections();
    uiStore.getState().setLocale('zh-CN');
    vi.spyOn(clock, 'now').mockReturnValue(NOW);
    // 输入行待记下的小图（R-416）用本机预览地址；jsdom 没有 createObjectURL
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: () => 'blob:pend', revokeObjectURL: () => undefined }));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetUploaderForTest();
    resetImageViewForTest();
    getBoot()?.cache?.close();
    resetBootForTest();
  });
}
