// 随手记插图数据层（B4 S3）：拍摄时间解析、重新编码的参数和失败码、路径拼法、错误映射、上传器（先写行再传、行写失败不上传、
// 等确认才传、写行被拒发提示、account 类错误走 accountExitOf → 离开本机、删除走放弃或软删）
// 真浏览器里的编码（JPEG 带 GPS → webp 没有 EXIF、拍摄时间留着）见 tests/e2e/b4-image-encode.spec.ts
import { describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import type { FileError, UploadResult } from '../../../platform/files.ts';
import { encodeImage, fitEdge, isHeic, THUMB_EDGE, THUMB_MAX, type Decoded, type EncodeDeps } from '../../../platform/image-encode.ts';
import { exifDateToMs, jpegTakenAt } from '../../../platform/image-exif.ts';
import { createUploader, type UploaderDeps } from '../data/image-uploader.ts';
import { createImageView, livePaths } from '../data/image-view.ts';
import { imagePath, imageRow, rowSyncOf, thumbPath, uploadFailKey, uploadPair, uuidv7, type QueueItem } from '../data/note-images.ts';
import { bareJpeg, exifApp1, withExif } from './exif-sample.ts';

const TZ = 'Asia/Seoul';
const U = '00000000-0000-4000-8000-0000000000aa';
const N = '00000000-0000-4000-8000-0000000000bb';
const err = (kind: FileError['kind'], code: string, reason?: string, status = 403): FileError => ({ ok: false, kind, code, status, ...(reason ? { reason } : {}) });

describe('拍摄时间（R-108：只留拍摄时间）', () => {
  it('JPEG 的 DateTimeOriginal 按 current_tz 换算；小端、大端都认；带 GPS 也只取时间', () => {
    const want = msAt('2026-10-21', 14 * 60 + 5, TZ) + 9000;
    for (const le of [true, false]) {
      const buf = withExif(bareJpeg(), exifApp1({ date: '2026:10:21 14:05:09', gps: true, le }));
      expect(jpegTakenAt(buf.buffer as ArrayBuffer, TZ)).toBe(want);
    }
  });
  it('没有 EXIF、不是 JPEG、日期不合法都回 null', () => {
    expect(jpegTakenAt(bareJpeg().buffer as ArrayBuffer, TZ)).toBeNull();
    expect(jpegTakenAt(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer, TZ)).toBeNull();
    expect(exifDateToMs('2026:02:30 10:00:00', TZ)).toBeNull();
    expect(exifDateToMs('0000:00:00 00:00:00', TZ)).toBeNull();
    expect(jpegTakenAt(withExif(bareJpeg(), exifApp1({ date: '2026:13:01 00:00:00' })).buffer as ArrayBuffer, TZ)).toBeNull();
  });
});

/**
 * 假解码、假画布：原生导出的大小 = 宽 × 高 × 质量 × k（k 控制会不会超），type 是 nativeType。
 * wasm 默认载不进来（这里只测原生那条路；wasm 那条路见 image-encode-wasm.test.ts）
 */
function fakeEncode(k: number, nativeType = 'image/webp', w = 4000, h = 3000) {
  const renders: { w: number; h: number; q: number }[] = [];
  const deps: EncodeDeps = {
    decode: () => Promise.resolve({ width: w, height: h, close: vi.fn() } satisfies Decoded),
    canvas: (_s, rw, rh) => ({
      toBlob: (q) => {
        renders.push({ w: rw, h: rh, q });
        // 只要 size、type（不真的分配那么多字节）
        return Promise.resolve({ size: Math.round(rw * rh * q * k), type: nativeType } as Blob);
      },
      pixels: () => ({ data: new Uint8ClampedArray(rw * rh * 4), width: rw, height: rh }),
      free: vi.fn(),
    }),
    wasm: () => Promise.reject(new TypeError('offline')),
    native: {},
    now: () => 0,
  };
  return { deps, renders };
}

describe('重新编码（webp；原图长边 ≤ 2048、≤ 2 MB；缩略图长边 ≤ 384、≤ 128 KB）', () => {
  it('长边缩到 2048 / 384；超了逐步降质量；产物都是 webp', async () => {
    const { deps, renders } = fakeEncode(0.9);
    const r = await encodeImage(new File([new Uint8Array(10)], 'a.png', { type: 'image/png' }), TZ, deps);
    if (!r.ok) throw new Error(r.code);
    expect([r.width, r.height]).toEqual([2048, 1536]);
    expect(r.full.type).toBe('image/webp');
    expect(r.full.size).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(r.thumb.size).toBeLessThanOrEqual(THUMB_MAX);
    expect(renders.some((x) => x.q < 0.85)).toBe(true);
    const t = renders.filter((x) => Math.max(x.w, x.h) <= THUMB_EDGE);
    expect(Math.max(t[0]?.w ?? 0, t[0]?.h ?? 0)).toBe(THUMB_EDGE);
    expect(r.takenAt).toBeNull();
  });
  it('HEIC 解不了 → heic_unsupported（看 type 或扩展名）；别的解不了 → decode_failed', async () => {
    const bad: EncodeDeps = { ...fakeEncode(1).deps, decode: () => Promise.reject(new DOMException('bad image', 'EncodingError')) };
    // 解码失败也带诊断：why=decode、错误名（只记 e.name）
    const diag = { path: 'native', native: null, ms: 0, loadMs: 0, encMs: 0, why: 'decode', err: 'EncodingError' };
    expect(await encodeImage(new File([], 'IMG_1.HEIC', { type: '' }), TZ, bad)).toEqual({ ok: false, code: 'heic_unsupported', diag });
    expect(await encodeImage(new File([], 'a', { type: 'image/heif' }), TZ, bad)).toEqual({ ok: false, code: 'heic_unsupported', diag });
    expect(await encodeImage(new File([], 'a.jpg', { type: 'image/jpeg' }), TZ, bad)).toEqual({ ok: false, code: 'decode_failed', diag });
    expect(isHeic({ type: 'image/jpeg', name: 'a.jpg' })).toBe(false);
  });
  it('原生导不出 webp（回了 png）且 wasm 也载不进来 → encode_load_failed（R-402：不再是“换个浏览器”）；怎么降都超 → too_big', async () => {
    expect(await encodeImage(new File([], 'a.png', { type: 'image/png' }), TZ, fakeEncode(0.1, 'image/png').deps)).toMatchObject({
      ok: false,
      code: 'encode_load_failed',
      diag: { path: 'wasm', native: 'image/png', why: 'load', err: 'TypeError' },
    });
    expect(await encodeImage(new File([], 'a.png', { type: 'image/png' }), TZ, fakeEncode(1000).deps)).toMatchObject({ ok: false, code: 'too_big', diag: { path: 'native' } });
  });
  it('fitEdge 不放大', () => {
    expect(fitEdge(300, 200, 384)).toEqual({ w: 300, h: 200 });
    expect(fitEdge(200, 4000, 2048)).toEqual({ w: 102, h: 2048 });
  });
});

describe('路径和整行（库里 check 钉死的拼法）', () => {
  it('path = <uid>/<note_id>/<id>.webp；缩略图同名 .t.webp；整行只放客户端能写的列', () => {
    const id = uuidv7(Date.UTC(2026, 10, 11), () => new Uint8Array(16).fill(0xff));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(imagePath(U, N, id)).toBe(`${U}/${N}/${id}.webp`);
    expect(thumbPath(imagePath(U, N, id))).toBe(`${U}/${N}/${id}.t.webp`);
    const row = imageRow(U, N, id, { bytes: 123, width: 4, height: 3, takenAt: 5 });
    expect(Object.keys(row).sort()).toEqual(['bucket', 'bytes', 'has_thumb', 'height', 'id', 'mime', 'note_id', 'path', 'taken_at', 'width']);
    expect(row).toMatchObject({ bucket: 'images', mime: 'image/webp', has_thumb: true, bytes: 123 });
  });
  it('UUID v7 按时间排得出先后', () => {
    expect(uuidv7(1000) < uuidv7(2000)).toBe(true);
  });
});

describe('上传的拒绝 → 提示', () => {
  it('quota_exceeded / length_mismatch / length_required（403 reason 和 411 code）各一条；413、415、426；retry、auth、resign 退避重试', () => {
    expect(uploadFailKey(err('denied', 'forbidden', 'quota_exceeded'))).toBe('quota');
    expect(uploadFailKey(err('denied', 'forbidden', 'length_mismatch'))).toBe('length');
    expect(uploadFailKey(err('denied', 'forbidden', 'length_required'))).toBe('length');
    expect(uploadFailKey(err('denied', 'length_required', undefined, 411))).toBe('length');
    expect(uploadFailKey(err('too_big', 'too_large', undefined, 413))).toBe('too_big');
    expect(uploadFailKey(err('bad_type', 'bad_type', undefined, 415))).toBe('bad_type');
    expect(uploadFailKey(err('upgrade', 'upgrade_required', undefined, 426))).toBe('upgrade');
    expect(uploadFailKey(err('denied', 'forbidden', 'no_row'))).toBe('denied');
    for (const k of ['retry', 'auth', 'resign'] as const) expect(uploadFailKey(err(k, 'x'))).toBeNull();
  });
  it('uploadPair：先原图后缩略图；retry 类按退避重试，退完还不行报 retry；account 类原样交回', async () => {
    const calls: string[] = [];
    const seq: UploadResult[] = [err('retry', 'network', undefined, 0), { ok: true, etag: null, existed: false }, { ok: true, etag: null, existed: false }];
    const sleep = vi.fn(() => Promise.resolve());
    const up = (p: string) => (calls.push(p), Promise.resolve(seq.shift() ?? { ok: true as const, etag: null, existed: false }));
    expect(await uploadPair(up, 'a/b/c.webp', new Blob(), new Blob(), sleep)).toBe('ok');
    expect(calls).toEqual(['a/b/c.webp', 'a/b/c.webp', 'a/b/c.t.webp']);
    expect(sleep).toHaveBeenCalledWith(2000);
    const always = () => Promise.resolve(err('retry', 'timeout', undefined, 0));
    expect(await uploadPair(always, 'p.webp', new Blob(), new Blob(), sleep, [1, 1])).toBe('retry');
    const acct = err('account', 'session_revoked', undefined, 401);
    expect(await uploadPair(() => Promise.resolve(acct), 'p.webp', new Blob(), new Blob(), sleep)).toBe(acct);
  });
  it('rowSyncOf：发送失败 > 排队中 > 确认 / 没了', () => {
    const q = (state: QueueItem['state'], error: string | null = null): QueueItem => ({ rec: 'note_images:i', state, error });
    expect(rowSyncOf([q('pending'), q('failed', 'quota_exceeded')], 'i', true)).toEqual({ s: 'failed', code: 'quota_exceeded' });
    expect(rowSyncOf([q('inflight')], 'i', true)).toEqual({ s: 'pending' });
    expect(rowSyncOf([{ rec: 'notes:i', state: 'pending', error: null }], 'i', true)).toEqual({ s: 'confirmed' });
    expect(rowSyncOf([], 'i', false)).toEqual({ s: 'gone' });
  });
});

/** 上传器的假依赖：队列由 setQueue 控制，onQueue 记下回调手动叫 */
function harness(over: Partial<UploaderDeps> = {}) {
  let queue: QueueItem[] = [];
  const rows = new Set<string>();
  const wake = new Set<() => void>();
  const view = createImageView({ sign: vi.fn(), fetchBlob: vi.fn(), objectUrl: () => 'blob:x', revoke: vi.fn() });
  const deps: UploaderDeps = {
    userId: () => U,
    tz: () => TZ,
    now: () => Date.UTC(2026, 10, 11),
    encode: () => Promise.resolve({ ok: true, full: new Blob([new Uint8Array(7)], { type: 'image/webp' }), thumb: new Blob([new Uint8Array(3)], { type: 'image/webp' }), width: 4, height: 3, takenAt: 9, diag: { path: 'wasm', native: 'image/png', ms: 12, loadMs: 5, encMs: 6 } }),
    insert: vi.fn((row: Record<string, unknown> & { id: string }) => {
      rows.add(row.id);
      queue = [{ rec: `note_images:${row.id}`, state: 'pending', error: null }];
      return Promise.resolve('ok' as const);
    }),
    queue: () => Promise.resolve(queue),
    onQueue: (fn) => (wake.add(fn), () => wake.delete(fn)),
    rowExists: (id) => rows.has(id),
    isPrivate: () => false,
    isReadonly: () => false,
    upload: vi.fn(() => Promise.resolve<UploadResult>({ ok: true, etag: null, existed: false })),
    sid: () => 'sid-1',
    exitOf: vi.fn(() => Promise.resolve('removed' as const)),
    leave: vi.fn(() => Promise.resolve()),
    dropFailed: vi.fn(() => Promise.resolve(true)),
    softDelete: vi.fn(() => Promise.resolve(true)),
    objectUrl: () => 'blob:local',
    revoke: vi.fn(),
    sleep: () => Promise.resolve(),
    view,
    pollMs: 5,
    ...over,
  };
  const u = createUploader(deps);
  const notices: unknown[] = [];
  u.onNotice((n) => notices.push(n));
  return {
    u,
    deps,
    notices,
    view,
    setQueue(q: QueueItem[]) {
      queue = q;
      for (const f of [...wake]) f();
    },
  };
}
const file = () => new File([new Uint8Array(5)], 'a.jpg', { type: 'image/jpeg' });

describe('上传器的运行日志（11-13 负责人问“随手记加不了图片”时日志里一行都没有，先补日志）', () => {
  it('每一步一行：开始（类型、大小）、压图结果、行确认、上传结果和耗时；不记文件名和内容', async () => {
    const lines: string[] = [];
    const h = harness({ log: (l) => lines.push(l) });
    const r = await h.u.insert(N, file());
    if (!r.ok) throw new Error(r.code);
    h.setQueue([]);
    await vi.waitFor(() => expect(h.u.getSnapshot()).toEqual([]));
    // 压图只有这一行：结果 + 编码诊断（R-402 评审 8：编码器自己不再另记）
    expect(lines).toEqual([
      'notes img start type=image/jpeg kb=0 new=false',
      'notes img encode ok kb=0 thumbKb=0 4x3 path=wasm native=image/png ms=12 loadMs=5 encMs=6',
      'notes img insert ok ms=0',
      'notes img row confirmed',
      'notes img upload ok ms=0',
    ]);
    expect(lines.join(' ')).not.toContain('a.jpg');
  });
  it('失败也各记一行：压图失败带失败码；上传被拒带种类和服务器码', async () => {
    const lines: string[] = [];
    const h = harness({ log: (l) => lines.push(l), encode: () => Promise.resolve({ ok: false, code: 'heic_unsupported' }) });
    expect(await h.u.insert(N, file())).toEqual({ ok: false, code: 'heic_unsupported' });
    expect(lines).toEqual(['notes img start type=image/jpeg kb=0 new=false', 'notes img encode heic_unsupported', 'notes img insert heic_unsupported ms=0']);
    const wasmFail: string[] = [];
    const hw = harness({ log: (l) => wasmFail.push(l), encode: () => Promise.resolve({ ok: false, code: 'encode_failed', diag: { path: 'wasm', native: 'image/png', ms: 9, loadMs: 2, encMs: 7, why: 'enc', err: 'RangeError' } }) });
    expect(await hw.u.insert(N, file())).toEqual({ ok: false, code: 'encode_failed' });
    expect(wasmFail[1]).toBe('notes img encode encode_failed path=wasm native=image/png ms=9 loadMs=2 encMs=7 why=enc err=RangeError');
    const up: string[] = [];
    const h2 = harness({ log: (l) => up.push(l), upload: vi.fn(() => Promise.resolve<UploadResult>(err('denied', 'forbidden', 'not_owner'))), exitOf: vi.fn(() => Promise.resolve('active' as const)) });
    await h2.u.insert(N, file());
    h2.setQueue([]);
    await vi.waitFor(() => expect(up.some((l) => l.startsWith('notes img fail'))).toBe(true));
    expect(up).toContain('notes img put full denied code=forbidden reason=not_owner');
    expect(up.some((l) => l.startsWith('notes img upload '))).toBe(true);
  });
});

describe('上传器：先写行再传', () => {
  it('行写进去以后、确认之前不传；确认了依次传原图和缩略图，传完从待传里拿掉、显示改用本机那一份', async () => {
    const h = harness();
    const r = await h.u.insert(N, file());
    if (!r.ok) throw new Error(r.code);
    expect(h.deps.insert).toHaveBeenCalledWith(expect.objectContaining({ id: r.id, note_id: N, path: `${U}/${N}/${r.id}.webp`, bytes: 7, taken_at: 9 }), N);
    expect(h.u.getSnapshot()).toMatchObject([{ id: r.id, state: 'writing' }]);
    await new Promise((res) => setTimeout(res, 20));
    expect(h.deps.upload).not.toHaveBeenCalled();
    h.setQueue([]);
    await vi.waitFor(() => expect(h.u.getSnapshot()).toEqual([]));
    expect(vi.mocked(h.deps.upload).mock.calls.map((c) => c[0])).toEqual([`${U}/${N}/${r.id}.webp`, `${U}/${N}/${r.id}.t.webp`]);
    expect(h.view.peek(`${U}/${N}/${r.id}.webp`)).toBe('blob:local');
  });
  it('行写失败（failed）不上传，提示 write_failed；换账号途中（switching）不提示', async () => {
    const h = harness({ insert: vi.fn(() => Promise.resolve('failed' as const)) });
    expect(await h.u.insert(N, file())).toEqual({ ok: false, code: 'write_failed' });
    const h2 = harness({ insert: vi.fn(() => Promise.resolve('switching' as const)) });
    expect(await h2.u.insert(N, file())).toEqual({ ok: false, code: 'silent' });
    await new Promise((res) => setTimeout(res, 20));
    expect(h.deps.upload).not.toHaveBeenCalled();
    expect(h.u.getSnapshot()).toEqual([]);
  });
  it('隐私记、只读行都不让插图：不编码、不写行，回 private / readonly（安全审建议 5；TC-B4-09 写入入口统一拦下）', async () => {
    for (const [dep, code] of [['isPrivate', 'private'], ['isReadonly', 'readonly']] as const) {
      const encode = vi.fn(() => Promise.resolve({ ok: false as const, code: 'heic_unsupported' as const }));
      const h = harness({ [dep]: (id: string) => id === N, encode });
      expect(await h.u.insert(N, file())).toEqual({ ok: false, code });
      expect(encode).not.toHaveBeenCalled();
      expect(h.deps.insert).not.toHaveBeenCalled();
    }
  });
  it('编码失败（HEIC）不写行、不上传', async () => {
    const h = harness({ encode: () => Promise.resolve({ ok: false, code: 'heic_unsupported' }) });
    expect(await h.u.insert(N, file())).toEqual({ ok: false, code: 'heic_unsupported' });
    expect(h.deps.insert).not.toHaveBeenCalled();
  });
  it('写行被服务器拒（quota_exceeded，进发送失败区）：不上传，标“没传上”并发 quota 提示；retry 回 false、不重发提示；删除走放弃（dropFailed）', async () => {
    const h = harness();
    const r = await h.u.insert(N, file());
    if (!r.ok) throw new Error(r.code);
    h.setQueue([{ rec: `note_images:${r.id}`, state: 'failed', error: 'quota_exceeded' }]);
    await vi.waitFor(() => expect(h.u.getSnapshot()).toMatchObject([{ state: 'failed', fail: 'quota' }]));
    expect(h.notices).toEqual([{ key: 'quota', noteId: N }]);
    expect(h.deps.upload).not.toHaveBeenCalled();
    // 行那一段失败：“重新插入”不再传（回 false，界面改走重新选一张），也不重复发提示
    expect(h.u.retry(r.id)).toBe(false);
    await new Promise((res) => setTimeout(res, 20));
    expect(h.u.getSnapshot()).toMatchObject([{ state: 'failed', fail: 'quota' }]);
    expect(h.notices).toHaveLength(1);
    expect(h.deps.upload).not.toHaveBeenCalled();
    expect(await h.u.remove(r.id)).toBe(true);
    expect(h.deps.dropFailed).toHaveBeenCalledWith(r.id);
    expect(h.deps.softDelete).not.toHaveBeenCalled();
    expect(h.u.getSnapshot()).toEqual([]);
  });
  it('上传被拒 quota_exceeded：标“没传上”、发 quota 提示；“重新插入”（图还在内存）再传一次；删除已确认的走软删', async () => {
    const results: UploadResult[] = [err('denied', 'forbidden', 'quota_exceeded')];
    const h = harness({ upload: vi.fn(() => Promise.resolve(results.shift() ?? { ok: true as const, etag: null, existed: false })) });
    const r = await h.u.insert(N, file());
    if (!r.ok) throw new Error(r.code);
    h.setQueue([]);
    await vi.waitFor(() => expect(h.u.getSnapshot()).toMatchObject([{ state: 'failed', fail: 'quota' }]));
    expect(h.notices).toEqual([{ key: 'quota', noteId: N }]);
    expect(h.u.retry(r.id)).toBe(true);
    await vi.waitFor(() => expect(h.u.getSnapshot()).toEqual([]));
    expect(await h.u.remove(r.id)).toBe(true);
    expect(h.deps.softDelete).toHaveBeenCalledWith(r.id);
  });
  it('account 类错误：经 accountExitOf 定原因（带发请求前的 sid），再离开本机；探测出账号正常（active）只提示、不离开', async () => {
    const acct = err('account', 'session_revoked', undefined, 401);
    const h = harness({ upload: vi.fn(() => Promise.resolve(acct)) });
    const r = await h.u.insert(N, file());
    if (!r.ok) throw new Error(r.code);
    h.setQueue([]);
    await vi.waitFor(() => expect(h.deps.leave).toHaveBeenCalledWith('removed', 'sid-1'));
    expect(h.deps.exitOf).toHaveBeenCalledWith(acct, 'sid-1');

    const h2 = harness({ upload: vi.fn(() => Promise.resolve(err('account', 'account_disabled'))), exitOf: vi.fn(() => Promise.resolve('active' as const)) });
    const r2 = await h2.u.insert(N, file());
    if (!r2.ok) throw new Error(r2.code);
    h2.setQueue([]);
    await vi.waitFor(() => expect(h2.u.getSnapshot()).toMatchObject([{ state: 'failed', fail: 'retry' }]));
    expect(h2.deps.leave).not.toHaveBeenCalled();
  });
  it('行在 outbox 里没了（别处放弃了）：本机这份也丢掉，不上传', async () => {
    const h2 = harness({ rowExists: () => false });
    const r2 = await h2.u.insert(N, file());
    if (!r2.ok) throw new Error(r2.code);
    h2.setQueue([]);
    await vi.waitFor(() => expect(h2.u.getSnapshot()).toEqual([]));
    expect(h2.deps.upload).not.toHaveBeenCalled();
    expect(h2.deps.revoke).toHaveBeenCalledWith('blob:local');
  });
});

describe('显示（sign view → fetchBlob → blob: 地址）', () => {
  it('同一轮的路径攒成一批签名；签名过期重签一次；not_found 报 missing；成功的缓存', async () => {
    const sign = vi.fn((items: readonly { path: string }[]) =>
      Promise.resolve(items.map((x) => ({ ok: true as const, url: `https://x/files/v1/o/images/${x.path}`, sig: 's', expiresAt: 1 }))),
    );
    let first = true;
    const fetchBlob = vi.fn(({ url }: { url: string }) => {
      if (url.endsWith('gone.webp')) return Promise.resolve(err('denied', 'not_found', undefined, 404));
      if (url.endsWith('old.webp') && first) {
        first = false;
        return Promise.resolve(err('resign', 'expired'));
      }
      return Promise.resolve({ ok: true as const, blob: new Blob(), contentType: 'image/webp' });
    });
    const v = createImageView({ sign, fetchBlob, objectUrl: () => 'blob:u', revoke: vi.fn() });
    const [a, b, c] = await Promise.all([v.get('a.webp'), v.get('gone.webp'), v.get('old.webp')]);
    expect(sign.mock.calls[0]?.[0]).toHaveLength(3);
    expect(a).toEqual({ ok: true, url: 'blob:u' });
    expect(b).toEqual({ ok: false, missing: true });
    expect(c).toEqual({ ok: true, url: 'blob:u' });
    expect(v.peek('a.webp')).toBe('blob:u');
    expect(v.peek('gone.webp')).toBeNull();
  });
  it('blob: 地址有上限，超了 revoke 最早的；prune 只留还在用的行（软删、撤销、集合清空都 revoke，安全审建议 4）', () => {
    const revoke = vi.fn();
    const v = createImageView({ sign: vi.fn(), fetchBlob: vi.fn(), objectUrl: () => 'blob:n', revoke, max: 2 });
    v.seed('a.webp', 'blob:a');
    v.seed('b.webp', 'blob:b');
    v.seed('c.webp', 'blob:c');
    expect(revoke).toHaveBeenCalledWith('blob:a');
    expect(v.peek('a.webp')).toBeNull();
    const rows = [{ path: 'b.webp' }, { path: 'c.webp', deleted_at: 1 }];
    expect([...livePaths(rows)]).toEqual(['b.webp', 'b.t.webp']);
    v.prune(livePaths(rows));
    expect(revoke).toHaveBeenLastCalledWith('blob:c');
    expect(v.peek('b.webp')).toBe('blob:b');
    v.prune(livePaths([]));
    expect(revoke).toHaveBeenLastCalledWith('blob:b');
  });
});
