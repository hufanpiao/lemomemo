// file-check（B4b-1；架构 5.13 第 2 点“服务器 fn file-check”）：客户端 check、cron sweep 的判定和写回
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sniffFile } from '../../shared/logic/files/file-sniff.ts';
import { inflateRaw } from '../../shared/logic/files/inflate.ts';
import { FILE_MAX_BYTES } from '../../shared/logic/files/limits.ts';
import { noteFilePath, noteFileThumbPath } from '../../shared/logic/files/media-path.ts';
import { fileCheckReq } from '../../shared/schema/attachments.ts';
import { type Deps, type FileRow, handle, MISSING_GIVE_UP_MS, RATE_PER_MIN, SWEEP_AFTER_MS } from '../../supabase/functions/file-check/core.ts';
import { A, B, FakeR2, jwtFor, T0, uuid } from '../functions/vault-fakes.ts';

const N = uuid(1);
const F = uuid(2);
const pdf = (n = 64) => {
  const b = new Uint8Array(n);
  b.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
  return b;
};
const hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function world(rowOver: Partial<FileRow> = {}) {
  const r2 = new FakeR2();
  const logs: string[] = [];
  const beats: Record<string, number>[] = [];
  const rate = new Map<string, number>();
  const body = pdf();
  const rows = new Map<string, FileRow>([[F, {
    id: F, user_id: A, note_id: N, kind: 'pdf', bytes: body.length, sha256: hex(body), has_thumb: false, is_vault: false,
    deleted_at: null, check_status: 'pending', created_at: T0, ...rowOver,
  }]]);
  let ms = T0 + 1000;
  const key = noteFilePath(A, N, F, 'pdf');
  const deps: Deps = {
    async authenticate(req) {
      const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      const p = JSON.parse(atob((jwt.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'))) as { sub: string };
      return { ok: true, user: { userId: p.sub, sessionId: 's', jwt } };
    },
    async takeRate(k, limit) { const n = (rate.get(k) ?? 0) + 1; rate.set(k, n); return n <= limit; },
    cronSecret: 'c'.repeat(40),
    maxBytes: FILE_MAX_BYTES,
    parse(v) { const p = fileCheckReq.safeParse(v); return p.success ? p.data : null; },
    store: {
      async row(u, id) { const r = rows.get(id); return r && r.user_id === u ? { ...r } : null; },
      async stale(before, limit) { return [...rows.values()].filter((r) => r.check_status === 'pending' && !r.is_vault && r.created_at < before).slice(0, limit); },
      async settle(row, status) {
        const r = rows.get(row.id);
        if (!r || r.check_status !== 'pending') return false;
        r.check_status = status;
        return true;
      },
      async heartbeat(d) { beats.push(d); },
    },
    r2: { get: async (b, k) => { const o = await r2.get(b, k); return o ? { ...o, etag: '"e1"' } : null; }, head: (b, k) => r2.head(b, k), deleteMany: (b, k) => r2.deleteMany(b, k) },
    sniff: (b) => sniffFile(b, inflateRaw),
    sha256Hex: async (b) => hex(b),
    path: noteFilePath,
    thumbPath: noteFileThumbPath,
    now: () => ms,
    log: (c) => logs.push(c),
  };
  const putObj = (b: Uint8Array, k = key) => r2.objs.set(`files/${k}`, { bytes: b, contentType: 'application/pdf' });
  const call = (b: unknown, h: Record<string, string> = {}, u = A) =>
    handle(new Request('http://x/functions/v1/file-check', { method: 'POST', headers: { authorization: `Bearer ${jwtFor(u, 60, ms)}`, ...h }, body: JSON.stringify(b) }), deps);
  const check = async (u = A) => { const r = await call({ action: 'check', id: F }, {}, u); return { status: r.status, body: (await r.json()) as Record<string, unknown> }; };
  return { r2, rows, logs, beats, deps, body, key, putObj, call, check, advance: (d: number) => { ms += d; } };
}

describe('check', () => {
  it('通过：大小、sha256、类型都对 → ok，再调直接回 ok', async () => {
    const w = world();
    w.putObj(w.body);
    expect(await w.check()).toEqual({ status: 200, body: { status: 'ok' } });
    expect(w.rows.get(F)?.check_status).toBe('ok');
    expect(await w.check()).toEqual({ status: 200, body: { status: 'ok' } });
  });
  it('原文件还不在 → incomplete，不改状态；has_thumb 时缩略图不在也是 incomplete', async () => {
    const w = world({ has_thumb: true });
    expect((await w.check()).body).toEqual({ status: 'incomplete' });
    w.putObj(w.body);
    expect((await w.check()).body).toEqual({ status: 'incomplete' });
    w.putObj(new Uint8Array(10), noteFileThumbPath(A, N, F));
    expect((await w.check()).body).toEqual({ status: 'ok' });
  });
  it('哈希不对、大小不对、类型和行不一致 → rejected，对象（含缩略图）被删', async () => {
    for (const [obj, over] of [
      [pdf(64).fill(7, 10), {}],
      [pdf(65), {}],
      [pdf(64), { kind: 'docx' as const }],
    ] as const) {
      const w = world({ ...over, has_thumb: true });
      w.putObj(obj);
      w.putObj(new Uint8Array(3), noteFileThumbPath(A, N, F));
      const want = over.kind ? noteFilePath(A, N, F, 'docx') : w.key;
      if (over.kind) w.putObj(obj, want);
      expect((await w.check()).body).toEqual({ status: 'rejected', reason: 'unknown' });
      expect(w.r2.keys('files')).toEqual(over.kind ? [`files/${w.key}`] : []);
      expect(w.rows.get(F)?.check_status).toBe('rejected');
    }
  });
  it('认不出的内容按 unknown；超过 10 MB 按 too_big', async () => {
    const w = world();
    w.putObj(new Uint8Array(64));
    w.rows.get(F)!.sha256 = hex(new Uint8Array(64));
    expect((await w.check()).body).toEqual({ status: 'rejected', reason: 'unknown' });
    const v = world({ bytes: 10_485_761 });
    v.putObj(new Uint8Array(10_485_761));
    expect((await v.check()).body).toEqual({ status: 'rejected', reason: 'too_big' });
  });
  it('别人的、隐私记的、已删的 → 404；限流 429；请求不合格 400', async () => {
    expect((await world().check(B)).status).toBe(404);
    expect((await world({ is_vault: true }).check()).status).toBe(404);
    expect((await world({ deleted_at: T0 }).check()).status).toBe(404);
    const w = world();
    for (let i = 0; i < RATE_PER_MIN; i++) await w.check();
    expect((await w.check()).status).toBe(429);
    expect((await w.call({ action: 'check', id: 'x' })).status).toBe(400);
  });
  describe('账号停用（TC-B1-10）', () => {
    const denied = () => {
      const w = world();
      w.deps.authenticate = async () => ({ ok: false, response: new Response('{"error":"account_disabled"}', { status: 403 }) });
      return w;
    };
    it('TC-B1-10 file-check：管理员停用的账号回 403 account_disabled，不读对象、不改状态', async () => {
      const w = denied();
      w.putObj(w.body);
      const r = await w.check();
      expect(r.status).toBe(403);
      expect(r.body['error']).toBe('account_disabled');
      expect(w.rows.get(F)?.check_status).toBe('pending');
    });
    it('TC-B1-10 file-check：没有 profiles 行的账号回 403 account_disabled，不删对象', async () => {
      const w = denied();
      w.putObj(new Uint8Array([1, 2, 3]));
      const r = await w.check();
      expect(r.status).toBe(403);
      expect(r.body['error']).toBe('account_disabled');
      expect(w.r2.objs.size).toBe(1);
    });
  });
  it('写回时别处先判了：回那边的结果', async () => {
    const w = world();
    w.putObj(w.body);
    const settle = w.deps.store!.settle;
    w.deps.store!.settle = async (row) => { w.rows.get(row.id)!.check_status = 'rejected'; return settle(row, 'ok', null); };
    expect((await w.check()).body).toEqual({ status: 'rejected' });
  });
});

describe('sweep', () => {
  const H = { 'x-cron-secret': 'c'.repeat(40) };
  it('没有密钥 401；只挑早于 30 分钟的；原文件缺了超过 24 小时才放弃；写心跳', async () => {
    const w = world();
    expect((await w.call({ action: 'sweep' })).status).toBe(401);
    expect(await (await w.call({ action: 'sweep' }, H)).json()).toMatchObject({ rows: 0 });
    w.advance(SWEEP_AFTER_MS);
    expect(await (await w.call({ action: 'sweep' }, H)).json()).toMatchObject({ rows: 1, incomplete: 1 });
    w.advance(MISSING_GIVE_UP_MS);
    expect(await (await w.call({ action: 'sweep' }, H)).json()).toMatchObject({ rows: 1, rejected: 1 });
    expect(w.rows.get(F)?.check_status).toBe('rejected');
    expect(w.beats).toHaveLength(3);
  });
  it('缩略图缺了不影响原文件通过', async () => {
    const w = world({ has_thumb: true });
    w.putObj(w.body);
    w.advance(SWEEP_AFTER_MS);
    expect(await (await w.call({ action: 'sweep' }, H)).json()).toMatchObject({ passed: 1 });
  });
});
