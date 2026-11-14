// 附件上传器（data/attach-uploader.ts）：本机判 → 写行 → 等确认 → PUT → file-check；失败按原因提示；运行日志只记结果码
import { describe, expect, it, vi } from 'vitest';
import type { CheckResult } from '../data/file-check-api.ts';
import type { Prepared, PrepFail } from '../data/file-prep.ts';
import { createAttUploader, putFailKey, RATE_WAIT_MS, type AttNotice, type AttUploaderDeps } from '../data/attach-uploader.ts';
import type { FileError, UploadResult } from '../../../platform/files.ts';

const UID = '0e2e0000-0000-4000-8000-000000000001';
const NOTE = '0e2e0000-0000-4000-8000-000000000a01';

const prepared = (): Prepared => ({ ok: true, kind: 'pdf', mime: 'application/pdf', name: '报价.pdf', bytes: new Uint8Array([37, 80, 68, 70]), sha256: 'a'.repeat(64) }) as Prepared;
const err = (kind: FileError['kind'], code: string = kind, reason?: string): FileError => ({ ok: false, kind, code, status: 400, ...(reason ? { reason } : {}) }) as FileError;

function setup(over: Partial<AttUploaderDeps> = {}) {
  const lines: string[] = [];
  const rows = new Map<string, { check_status?: unknown }>();
  const deps: AttUploaderDeps = {
    userId: () => UID,
    now: () => 1_800_000_000_000,
    prepare: vi.fn(async (): Promise<Prepared | PrepFail> => prepared()),
    insert: vi.fn(async (row: { id: string }) => {
      rows.set(row.id, { check_status: 'pending' });
      return 'ok' as const;
    }),
    queue: async () => [],
    onQueue: () => () => undefined,
    rowExists: (id) => rows.has(id),
    checkStatus: (id) => rows.get(id)?.check_status,
    isPrivate: () => false,
    isReadonly: () => false,
    upload: vi.fn(async (): Promise<UploadResult> => ({ ok: true }) as UploadResult),
    check: vi.fn(async (): Promise<CheckResult> => ({ ok: true, status: 'ok' }) as CheckResult),
    sid: () => 'sid',
    exitOf: async () => null,
    leave: async () => undefined,
    dropFailed: async () => true,
    patch: vi.fn(async () => true),
    sleep: async () => undefined,
    pollMs: 1,
    log: (l) => lines.push(l),
    ...over,
  };
  const u = createAttUploader(deps);
  const notices: AttNotice[] = [];
  u.onNotice((n) => notices.push(n));
  return { u, deps, lines, notices, rows };
}

const file = (): File => new File([new Uint8Array([37, 80, 68, 70])], '报价.pdf', { type: 'application/pdf' });
const idle = async (u: ReturnType<typeof createAttUploader>): Promise<void> => {
  await vi.waitFor(() => expect(u.getSnapshot().every((p) => p.state === 'failed')).toBe(true));
};

describe('附件上传器', () => {
  it('成功：写一行（路径按 用户/随手记/id.kind，has_thumb false）→ PUT → file-check ok，待传清空', async () => {
    const { u, deps } = setup();
    const r = await u.add(NOTE, file());
    expect(r.ok).toBe(true);
    const row = vi.mocked(deps.insert).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row['path']).toBe(`${UID}/${NOTE}/${String(row['id'])}.pdf`);
    expect(row).toMatchObject({ note_id: NOTE, kind: 'pdf', has_thumb: false, bytes: 4, sha256: 'a'.repeat(64) });
    await idle(u);
    expect(u.getSnapshot()).toEqual([]);
    expect(deps.upload).toHaveBeenCalledWith(row['path'], expect.any(Blob), 'application/pdf');
    expect(deps.check).toHaveBeenCalledWith(row['id']);
  });

  it('本机判不过：不写行，提示原因（带文件名给界面），日志只记原因码', async () => {
    const { u, deps, notices, lines } = setup({ prepare: async () => ({ ok: false, reason: 'bad_archive', detail: 'bomb_total' }) });
    expect(await u.add(NOTE, file())).toEqual({ ok: false, key: 'bad_archive' });
    expect(deps.insert).not.toHaveBeenCalled();
    expect(notices).toEqual([{ key: 'bad_archive', noteId: NOTE, name: '报价.pdf' }]);
    expect(lines.join('\n')).not.toContain('报价');
    expect(lines).toContain('att prep bad_archive detail=bomb_total');
  });

  it('隐私记、只读：直接回原因，不提示（界面自己说）', async () => {
    const a = setup({ isPrivate: () => true });
    expect(await a.u.add(NOTE, file())).toEqual({ ok: false, key: 'private' });
    const b = setup({ isReadonly: () => true });
    expect(await b.u.add(NOTE, file())).toEqual({ ok: false, key: 'readonly' });
    expect([...a.notices, ...b.notices]).toEqual([]);
  });

  it('file-check 没收：按原因标失败并提示', async () => {
    const { u, notices } = setup({ check: async () => ({ ok: true, status: 'rejected', reason: 'unknown' }) as CheckResult });
    await u.add(NOTE, file());
    await idle(u);
    expect(u.getSnapshot()[0]).toMatchObject({ state: 'failed', fail: 'unknown' });
    expect(notices.at(-1)?.key).toBe('unknown');
  });

  it('file-check 限流：等 RATE_WAIT_MS 再查一次就成；再限流交给补扫（不标失败）', async () => {
    const check = vi.fn<() => Promise<CheckResult>>()
      .mockResolvedValueOnce({ ok: false, kind: 'retry', code: 'rate_limited' })
      .mockResolvedValueOnce({ ok: true, status: 'ok' } as CheckResult);
    const sleep = vi.fn(async () => undefined);
    const { u } = setup({ check, sleep });
    await u.add(NOTE, file());
    await vi.waitFor(() => expect(u.getSnapshot()).toHaveLength(0));
    expect(check).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(RATE_WAIT_MS);
    const again = setup({ check: async () => ({ ok: false, kind: 'retry', code: 'rate_limited' }) as CheckResult });
    await again.u.add(NOTE, file());
    await vi.waitFor(() => expect(again.u.getSnapshot()).toHaveLength(0));
    expect(again.notices).toHaveLength(0);
  });

  it('incomplete：再传一次再查，最多 3 次', async () => {
    const check = vi.fn(async (): Promise<CheckResult> => ({ ok: true, status: 'incomplete' }) as CheckResult);
    const { u, deps } = setup({ check });
    await u.add(NOTE, file());
    await idle(u);
    expect(deps.upload).toHaveBeenCalledTimes(3);
    expect(u.getSnapshot()[0]).toMatchObject({ fail: 'retry' });
  });

  it('网络错误退避三次后标“再试一次”，retry 重新传成', async () => {
    let n = 0;
    const upload = vi.fn(async (): Promise<UploadResult> => (n++ < 4 ? err('retry', 'network') : ({ ok: true } as UploadResult)));
    const { u, deps } = setup({ upload });
    await u.add(NOTE, file());
    await idle(u);
    expect(deps.upload).toHaveBeenCalledTimes(4);
    const id = u.getSnapshot()[0]?.id ?? '';
    expect(u.getSnapshot()[0]).toMatchObject({ fail: 'retry' });
    expect(u.retry(id)).toBe(true);
    await vi.waitFor(() => expect(u.getSnapshot()).toEqual([]));
  });

  it('PUT 回 not_pending：看行上的结果（rejected 当没能加上）', async () => {
    const { u, rows } = setup({ upload: async () => err('not_pending') });
    const r = await u.add(NOTE, file());
    if (r.ok) rows.set(r.id, { check_status: 'rejected' });
    await idle(u);
    expect(u.getSnapshot()[0]).toMatchObject({ fail: 'unknown' });
  });

  it('空间满（PUT 403 quota_exceeded）→ quota', () => {
    expect(putFailKey(err('denied', 'denied', 'quota_exceeded'))).toBe('quota');
    expect(putFailKey(err('too_big'))).toBe('too_big');
    expect(putFailKey(err('bad_type'))).toBe('unknown');
    expect(putFailKey(err('retry'))).toBeNull();
  });

  it('删除：行在就软删（deleted_at），撤销改回 null', async () => {
    const { u, deps, rows } = setup();
    rows.set('f1', { check_status: 'ok' });
    expect(await u.remove('f1')).toBe('soft');
    expect(deps.patch).toHaveBeenCalledWith('f1', { deleted_at: 1_800_000_000_000, updated_at: 1_800_000_000_000 });
    expect(await u.undoRemove('f1')).toBe(true);
    expect(deps.patch).toHaveBeenLastCalledWith('f1', { deleted_at: null, updated_at: 1_800_000_000_000 });
  });

  it('删除：行没写成（发送失败区）放弃、行本来就没了，都回 dropped（界面不给撤销），不软删', async () => {
    const a = setup({ queue: async () => [{ rec: 'note_files:f2', state: 'failed', error: 'quota_exceeded' }] });
    expect(await a.u.remove('f2')).toBe('dropped');
    const b = setup();
    expect(await b.u.remove('f3')).toBe('dropped');
    expect([...vi.mocked(a.deps.patch).mock.calls, ...vi.mocked(b.deps.patch).mock.calls]).toEqual([]);
  });
});
