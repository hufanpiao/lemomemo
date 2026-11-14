// vault-file（B4b-1；架构 5.13 第 11 点、0.21 R-118）：隐私记文档附件的上传、列表、读取、删除恢复、PPT 预览、清理。
// 用内存假库、假 R2、假 Storage 跑 core.ts；加密用真的 _shared/vault-files.ts，判型用真的 shared/logic/files（PDF 文件头即可）。
// 真库那一份（store.ts 的 SQL 以 fn_vault 打 lemo-e2e）在 supabase/tests/store-it/vault-file.it.ts。
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TTL } from '../../functions/_lib/files-rules.ts';
import { sanitizeFileName } from '../../shared/logic/files/file-name.ts';
import { sniffFile, zipBombCheck } from '../../shared/logic/files/file-sniff.ts';
import { inflateRaw } from '../../shared/logic/files/inflate.ts';
import { FILE_MAX_BYTES } from '../../shared/logic/files/limits.ts';
import { noteFilePath, noteFileThumbPath } from '../../shared/logic/files/media-path.ts';
import { DOC_TYPES, type DocKind } from '../../shared/manifests/attachments.ts';
import {
  VAULT_FILE_RATE_PER_MIN, VAULT_FILE_THUMB_MAX_BYTES, VAULT_FILE_UPLOAD_MAX_BODY, VAULT_PREVIEW_RATE_PER_HOUR, VAULT_PREVIEW_TTL_S,
  vaultFileErrorBody, vaultFileListResponse, vaultFileMeta, vaultFilePreviewResponse, vaultFileRequest, vaultFileUploadResponse,
} from '../../shared/schema/vault-file.ts';
import { ENC_KEY_ID } from '../../supabase/functions/_shared/vault-crypto.ts';
import { newDek, sealPart, sealText, shaMac, unwrapDek, openPart, wrapDek } from '../../supabase/functions/_shared/vault-files.ts';
import {
  type Deps, type FileRow, handle, type InsertResult, type NewRow, type Rules, STRAY_GRACE_MS,
} from '../../supabase/functions/vault-file/core.ts';
import { A, B, FakeR2, jwtFor, MASTER, T0, uuid } from '../functions/vault-fakes.ts';

const N = uuid(1);       // A 的隐私记
const NP = uuid(2);      // A 的普通随手记
const NB = uuid(3);      // B 的隐私记
const F = uuid(11);
const F2 = uuid(12);
const GOOD = 'tok-good';
const RELOCK = 'tok-relock';
const CRON = 'c'.repeat(40);
const pdf = (n = 64, fill = 1) => {
  const b = new Uint8Array(n).fill(fill);
  b.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
  return b;
};
const webp = (n = 40) => { const b = new Uint8Array(n).fill(9); b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]); return b; };
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

type Row = FileRow & { user_id: string; path: string; mime: string };

const RULES: Rules = {
  parse(v) { const p = vaultFileRequest.safeParse(v); return p.success ? p.data : null; },
  parseMeta(v) { const p = vaultFileMeta.safeParse(v); return p.success ? p.data : null; },
  sniff: (b) => sniffFile(b, inflateRaw),
  bomb: (b) => zipBombCheck(b, inflateRaw),
  sanitizeName: (raw, kind) => sanitizeFileName(raw, kind as DocKind),
  mime: (kind) => DOC_TYPES[kind as DocKind],
  fileKey: (u, n, id, kind) => noteFilePath(u, n, id, kind as DocKind),
  thumbKey: noteFileThumbPath,
  maxBytes: FILE_MAX_BYTES,
  thumbMaxBytes: VAULT_FILE_THUMB_MAX_BYTES,
  uploadMaxBody: VAULT_FILE_UPLOAD_MAX_BODY,
  ratePerMin: VAULT_FILE_RATE_PER_MIN,
  previewPerHour: VAULT_PREVIEW_RATE_PER_HOUR,
  previewTtlS: VAULT_PREVIEW_TTL_S,
};

function world() {
  let ms = T0;
  const r2 = new FakeR2();
  const logs: string[] = [];
  const beats: Record<string, number>[] = [];
  const rate = new Map<string, number>();
  const notes = new Map<string, { user_id: string; is_private: boolean; deleted_at: number | null }>([
    [N, { user_id: A, is_private: true, deleted_at: null }],
    [NP, { user_id: A, is_private: false, deleted_at: null }],
    [NB, { user_id: B, is_private: true, deleted_at: null }],
  ]);
  const rows = new Map<string, Row>();
  const previews = new Map<string, { user_id: string; file_id: string; expires_at: number }>();
  const objects = new Map<string, { body: Uint8Array; created_at: number; contentType?: string }>();
  let insertResult: InsertResult | null = null;
  const fail = { put: false, sign: false, remove: false };
  const deps: Deps = {
    async authenticate(req) {
      const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      const p = JSON.parse(atob((jwt.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'))) as { sub: string };
      return { ok: true, user: { userId: p.sub, sessionId: 's', jwt } };
    },
    async takeRate(k, limit) { const n = (rate.get(k) ?? 0) + 1; rate.set(k, n); return n <= limit; },
    async checkToken(_u, t) { return { verdict: t === GOOD ? 'ok' : t === RELOCK ? 'vault_relock' : 'vault_locked' }; },
    cronSecret: CRON,
    master: MASTER,
    rules: RULES,
    store: {
      async privateNote(u, id) { const n = notes.get(id); return !!n && n.user_id === u && n.is_private && n.deleted_at === null; },
      async file(u, id) { const r = rows.get(id); return r && r.user_id === u ? { ...r } : null; },
      async files(u, nid) {
        return [...rows.values()].filter((r) => r.user_id === u && r.note_id === nid && r.is_vault && r.deleted_at === null && r.check_status === 'ok')
          .sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => ({ ...r }));
      },
      async insert(u, r: NewRow) {
        if (insertResult) return insertResult;
        if (rows.has(r.id)) return 'exists';
        const n = notes.get(r.note_id);
        if (!n || n.user_id !== u || !n.is_private || n.deleted_at !== null) return 'no_note';
        rows.set(r.id, { ...r, user_id: u, path: noteFilePath(u, r.note_id, r.id, r.kind as DocKind), is_vault: true, check_status: 'ok', deleted_at: null });
        return 'ok';
      },
      async setDeleted(u, id, at) {
        const r = rows.get(id);
        if (!r || r.user_id !== u || !r.is_vault || (at === null ? r.deleted_at === null : r.deleted_at !== null)) return false;
        r.deleted_at = at;
        return true;
      },
      async previews(u) { return [...previews].filter(([, v]) => v.user_id === u).map(([k]) => k).sort(); },
      async register(u, path, fileId, exp) { previews.set(path, { user_id: u, file_id: fileId, expires_at: exp }); },
      async unregister(u, paths) { for (const p of paths) if (previews.get(p)?.user_id === u) previews.delete(p); },
      async expired() { return [...previews].filter(([, v]) => v.expires_at <= ms).map(([path, v]) => ({ path, user_id: v.user_id })); },
      async heartbeat(d) { beats.push(d); },
    },
    r2,
    preview: {
      async put(path, body, o) { if (fail.put) throw new Error('put'); objects.set(path, { body: new Uint8Array(body), created_at: ms, contentType: o.contentType }); },
      async sign(path, ttl) { if (fail.sign) throw new Error('sign'); return `/sb/storage/v1/object/sign/vault-preview/${path}?token=t.${ttl}`; },
      async remove(paths) { if (fail.remove) throw new Error('remove'); for (const p of paths) objects.delete(p); },
      async list() { return [...objects].map(([name, o]) => ({ name, created_at: o.created_at })); },
    },
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    now: () => ms,
    log: (c) => logs.push(c),
  };
  const headers = (u: string, token: string | null) => {
    const h: Record<string, string> = { authorization: `Bearer ${jwtFor(u, 60, ms)}` };
    if (token) h['x-vault-token'] = token;
    return h;
  };
  async function call(body: unknown, o: { user?: string; token?: string | null; h?: Record<string, string> } = {}) {
    const res = await handle(new Request('http://x/functions/v1/vault-file', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers(o.user ?? A, o.token === undefined ? GOOD : o.token), ...(o.h ?? {}) }, body: JSON.stringify(body),
    }), deps);
    const isJson = (res.headers.get('content-type') ?? '').startsWith('application/json');
    return { status: res.status, headers: res.headers, json: isJson ? (await res.json()) as Record<string, unknown> : null, bytes: isJson ? null : new Uint8Array(await res.arrayBuffer()) };
  }
  type Up = { id?: string; note?: string; kind?: string; name?: string; file?: Uint8Array; thumb?: Uint8Array | null; meta?: Record<string, unknown>; user?: string; token?: string | null };
  async function upload(o: Up = {}) {
    const file = o.file ?? pdf();
    const meta = { id: o.id ?? F, note_id: o.note ?? N, kind: o.kind ?? 'pdf', name: o.name ?? '合同.pdf', sha256: sha(file), bytes: file.length, pages: 2, text: '抽出的文字', ...(o.meta ?? {}) };
    const fd = new FormData();
    fd.set('meta', JSON.stringify(meta));
    fd.set('file', new Blob([file as Uint8Array<ArrayBuffer>]));
    if (o.thumb) fd.set('thumb', new Blob([o.thumb as Uint8Array<ArrayBuffer>]));
    const tmp = new Request('http://x', { method: 'POST', body: fd });
    const buf = new Uint8Array(await tmp.arrayBuffer());
    const res = await handle(new Request('http://x/functions/v1/vault-file', {
      method: 'POST', headers: { ...headers(o.user ?? A, o.token === undefined ? GOOD : o.token), 'content-type': tmp.headers.get('content-type') ?? '', 'content-length': String(buf.length) }, body: buf,
    }), deps);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }
  /** 直接在库里放一行隐私记附件（绕过上传：PPTX 判型要真 ZIP，这里只测预览） */
  async function seed(id: string, kind: string, plain: Uint8Array, o: { user?: string; note?: string; is_vault?: boolean } = {}) {
    const u = o.user ?? A;
    const note = o.note ?? N;
    const dek = await newDek();
    const key = RULES.fileKey(u, note, id, kind);
    rows.set(id, {
      id, note_id: note, kind, bytes: plain.length, pages: null, has_thumb: false, is_vault: o.is_vault ?? true, check_status: 'ok', deleted_at: null, created_at: ms,
      sha256: await shaMac(MASTER, u, sha(plain)), name_enc: await sealText(dek, u, id, 'name', `x.${kind}`), text_enc: null,
      dek_enc: await wrapDek(MASTER, u, id, dek), user_id: u, path: key, mime: RULES.mime(kind),
    });
    await r2.put('vault-files', key, await sealPart(dek, u, id, 'file', plain), { contentType: 'application/octet-stream' });
  }
  return {
    r2, logs, beats, rate, rows, notes, previews, objects, deps, fail, call, upload, seed,
    setInsert: (r: InsertResult | null) => { insertResult = r; },
    advance: (d: number) => { ms += d; },
    now: () => ms,
  };
}

const fkey = (id = F, n = N, u = A) => noteFilePath(u, n, id, 'pdf');

describe('upload', () => {
  it('成功：对象是密文（octet-stream）、键不带文件名；行里名字和文字加密、sha256 存 HMAC；回的条目合 schema', async () => {
    const w = world();
    const file = pdf(200);
    const thumb = webp();
    const r = await w.upload({ file, thumb, name: '合同.pdf' });
    expect(r.status).toBe(200);
    expect(vaultFileUploadResponse.parse(r.json).file).toMatchObject({ id: F, note_id: N, kind: 'pdf', name: '合同.pdf', bytes: 200, pages: 2, has_thumb: true });
    const o = w.r2.objs.get(`vault-files/${fkey()}`)!;
    expect(o.contentType).toBe('application/octet-stream');
    expect(Buffer.from(o.bytes).includes(Buffer.from(file.slice(0, 32)))).toBe(false);
    expect(w.r2.objs.get(`vault-files/${noteFileThumbPath(A, N, F)}`)?.contentType).toBe('application/octet-stream');
    expect(w.r2.keys('vault-files').some((k) => k.includes('合同'))).toBe(false);
    const row = w.rows.get(F)!;
    expect(row.sha256).toBe(await shaMac(MASTER, A, sha(file)));
    expect(row.sha256).not.toBe(sha(file));
    const dek = (await unwrapDek(MASTER, A, F, row.dek_enc!))!;
    expect(new TextDecoder().decode((await openPart(dek, A, F, 'name', row.name_enc!))!)).toBe('合同.pdf');
    expect(new TextDecoder().decode((await openPart(dek, A, F, 'text', row.text_enc!))!)).toBe('抽出的文字');
    expect(w.logs).toEqual(['upload_ok']);
  });

  it('锁着、令牌过期（relock）都拒：401，不写对象不写行', async () => {
    const w = world();
    expect((await w.upload({ token: null })).json).toEqual({ error: 'vault_locked' });
    expect((await w.upload({ token: RELOCK })).json).toEqual({ error: 'vault_relock' });
    expect(w.r2.objs.size + w.rows.size).toBe(0);
  });

  it('普通随手记、别人的隐私记、已删的隐私记：404，不写对象', async () => {
    const w = world();
    expect((await w.upload({ note: NP })).status).toBe(404);
    expect((await w.upload({ note: NB })).status).toBe(404);
    w.notes.get(N)!.deleted_at = 1;
    expect((await w.upload()).status).toBe(404);
    expect(w.r2.objs.size).toBe(0);
  });

  it('类型不对：内容不是认得的格式回 rejected unknown；内容是 PDF、kind 写 docx 也回 rejected', async () => {
    const w = world();
    const r1 = await w.upload({ file: new Uint8Array(64).fill(3) });
    expect([r1.status, r1.json]).toEqual([422, { error: 'rejected', reason: 'unknown' }]);
    vaultFileErrorBody.parse(r1.json);
    const r2 = await w.upload({ kind: 'docx', name: 'a.docx' });
    expect([r2.status, r2.json.error]).toEqual([422, 'rejected']);
    expect(w.r2.objs.size + w.rows.size).toBe(0);
  });

  it('bytes、sha256 和实际内容对不上回 400；meta 多字段、缩略图不是 webp 也回 400', async () => {
    const w = world();
    expect((await w.upload({ meta: { sha256: 'a'.repeat(64) } })).status).toBe(400);
    expect((await w.upload({ meta: { bytes: 63 } })).status).toBe(400);
    expect((await w.upload({ meta: { extra: 1 } })).status).toBe(400);
    expect((await w.upload({ thumb: pdf(20) })).status).toBe(400);
    expect(w.r2.objs.size).toBe(0);
  });

  it('太大：Content-Length 超过上限直接 413（不验身份）；原文件超过上限、缩略图超过 128 KB 也 413', async () => {
    const w = world();
    const res = await handle(new Request('http://x/functions/v1/vault-file', {
      method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(VAULT_FILE_UPLOAD_MAX_BODY + 1) }, body: 'x',
    }), w.deps);
    expect(res.status).toBe(413);
    expect(w.rate.size).toBe(0);
    w.deps.rules = { ...RULES, maxBytes: 100 };
    expect((await w.upload({ file: pdf(101) })).status).toBe(413);
    w.deps.rules = RULES;
    expect((await w.upload({ thumb: webp(VAULT_FILE_THUMB_MAX_BYTES + 1) })).status).toBe(413);
  });

  it('额度：写行回 quota → 403 quota_exceeded，刚写的对象删掉', async () => {
    const w = world();
    w.setInsert('quota');
    const r = await w.upload({ thumb: webp() });
    expect([r.status, r.json]).toEqual([403, { error: 'quota_exceeded' }]);
    expect(w.r2.keys('vault-files')).toEqual([]);
  });

  it('同 id 已有：先查到就 409 exists；写行时才撞上（并发）按已提交行的密钥重封对象，读回来还是对的', async () => {
    const w = world();
    const file = pdf(80, 5);
    await w.upload({ file });
    expect((await w.upload({ file })).json).toEqual({ error: 'exists' });
    // 并发：第二次在“查有没有”时还看不到行，写对象（新密钥）盖掉了第一次的，写行时撞上
    const real = w.deps.store!.file;
    let first = true;
    w.deps.store!.file = async (u, id) => { if (first) { first = false; return null; } return real(u, id); };
    expect((await w.upload({ file })).json).toEqual({ error: 'exists' });
    const got = await w.call({ action: 'get', id: F });
    expect([got.status, [...got.bytes!]]).toEqual([200, [...file]]);
  });

  it('写行抛错（库不通）：行不在就删对象，回 503 try_later', async () => {
    const w = world();
    w.deps.store!.insert = async () => { throw new Error('db'); };
    expect((await w.upload()).json).toEqual({ error: 'try_later' });
    expect(w.r2.objs.size).toBe(0);
  });
});

describe('list、get、remove、restore', () => {
  it('list 回解密后的名字；普通随手记 404；get 回明文字节（no-store、nosniff、按 kind 的类型）', async () => {
    const w = world();
    const file = pdf(90, 7);
    await w.upload({ file, thumb: webp(), name: 'a.pdf' });
    await w.upload({ id: F2, name: 'b.pdf' });
    const l = await w.call({ action: 'list', note_id: N });
    expect(vaultFileListResponse.parse(l.json).files.map((f) => [f.id, f.name])).toEqual([[F, 'a.pdf'], [F2, 'b.pdf']]);
    expect((await w.call({ action: 'list', note_id: NP })).status).toBe(404);
    const g = await w.call({ action: 'get', id: F });
    expect([g.status, g.headers.get('content-type'), g.headers.get('x-content-type-options'), g.headers.get('cache-control')]).toEqual([200, 'application/pdf', 'nosniff', 'no-store']);
    expect([...g.bytes!]).toEqual([...file]);
    const t = await w.call({ action: 'get', id: F, part: 'thumb' });
    expect([t.headers.get('content-type'), [...t.bytes!]]).toEqual(['image/webp', [...webp()]]);
    expect((await w.call({ action: 'get', id: F2, part: 'thumb' })).status).toBe(404);
    expect((await w.call({ action: 'get', id: F }, { user: B })).status).toBe(404);
  });

  it('HMAC 不一致不给：行里 sha256 被改过，get 回 500 corrupt、记 decrypt_failed', async () => {
    const w = world();
    await w.upload();
    w.rows.get(F)!.sha256 = await shaMac(MASTER, A, 'e'.repeat(64));
    const g = await w.call({ action: 'get', id: F });
    expect([g.status, g.json]).toEqual([500, { error: 'corrupt' }]);
    expect(w.logs).toContain('decrypt_failed');
  });

  it('AAD 互换解密失败：原文件和缩略图的密文对调、两个文件的名字密文对调，都解不开', async () => {
    const w = world();
    await w.upload({ thumb: webp() });
    await w.upload({ id: F2, name: 'b.pdf' });
    const fk = `vault-files/${fkey()}`;
    const tk = `vault-files/${noteFileThumbPath(A, N, F)}`;
    const f = w.r2.objs.get(fk)!;
    w.r2.objs.set(fk, w.r2.objs.get(tk)!);
    w.r2.objs.set(tk, f);
    expect((await w.call({ action: 'get', id: F })).status).toBe(500);
    expect((await w.call({ action: 'get', id: F, part: 'thumb' })).status).toBe(500);
    const a = w.rows.get(F)!;
    const b = w.rows.get(F2)!;
    [a.name_enc, b.name_enc] = [b.name_enc, a.name_enc];
    const l = await w.call({ action: 'list', note_id: N });
    expect((l.json!.files as { name: string }[]).map((x) => x.name)).toEqual(['file.pdf', 'file.pdf']);
  });

  it('remove 软删（list 不再回、get 404），restore 恢复；别人的、重复删回 404', async () => {
    const w = world();
    await w.upload();
    expect((await w.call({ action: 'remove', id: F })).json).toEqual({ ok: true });
    expect(w.rows.get(F)?.deleted_at).toBe(w.now());
    expect((await w.call({ action: 'remove', id: F })).status).toBe(404);
    expect((await w.call({ action: 'get', id: F })).status).toBe(404);
    expect((await w.call({ action: 'list', note_id: N })).json!.files).toEqual([]);
    expect((await w.call({ action: 'restore', id: F }, { user: B })).status).toBe(404);
    expect((await w.call({ action: 'restore', id: F })).json).toEqual({ ok: true });
    expect((await w.call({ action: 'get', id: F })).status).toBe(200);
  });

  it('普通随手记上的附件（is_vault = false）这条一律不认：get、remove、ms_preview 都 404', async () => {
    const w = world();
    await w.seed(F, 'pptx', new Uint8Array([1, 2, 3]), { note: NP, is_vault: false });
    expect((await w.call({ action: 'get', id: F })).status).toBe(404);
    expect((await w.call({ action: 'remove', id: F })).status).toBe(404);
    expect((await w.call({ action: 'ms_preview', id: F })).status).toBe(404);
    expect(w.objects.size + w.previews.size).toBe(0);
  });
});

describe('ms_preview、ms_preview_end', () => {
  const PPTX = new TextEncoder().encode('PK fake pptx body');

  it('成功：先登记再写对象；路径是 32 位随机十六进制、不含 user_id 和文件名；链接合 schema、有效期 300 秒', async () => {
    const w = world();
    await w.seed(F, 'pptx', PPTX);
    const r = await w.call({ action: 'ms_preview', id: F });
    expect(r.status).toBe(200);
    const body = vaultFilePreviewResponse.parse(r.json);
    expect(body.expires_at).toBe(w.now() + 300_000);
    const [path] = [...w.objects.keys()];
    expect(path).toMatch(/^[0-9a-f]{32}\.pptx$/);
    expect(body.url).toContain(path);
    expect(body.url.includes(A) || path!.includes(A)).toBe(false);
    expect([...w.previews.keys()]).toEqual([path]);
    expect([...w.objects.get(path!)!.body]).toEqual([...PPTX]);
    expect(w.objects.get(path!)!.contentType).toBe(DOC_TYPES.pptx);
    expect(w.logs).toEqual(['preview_ok']);
  });

  it('不是 pptx 的 404；锁着的 401；再开一个先删上一个；end 后对象和登记都不在', async () => {
    const w = world();
    await w.seed(F, 'pptx', PPTX);
    await w.upload({ id: F2 });
    expect((await w.call({ action: 'ms_preview', id: F2 })).status).toBe(404);
    expect((await w.call({ action: 'ms_preview', id: F }, { token: null })).status).toBe(401);
    await w.call({ action: 'ms_preview', id: F });
    const first = [...w.objects.keys()];
    await w.call({ action: 'ms_preview', id: F });
    expect(w.objects.size).toBe(1);
    expect(w.objects.has(first[0]!)).toBe(false);
    expect((await w.call({ action: 'ms_preview_end' })).json).toEqual({ ok: true });
    expect(w.objects.size + w.previews.size).toBe(0);
  });

  it('写对象失败：删登记、回 503；签名失败：对象和登记都删', async () => {
    const w = world();
    await w.seed(F, 'pptx', PPTX);
    w.fail.put = true;
    expect((await w.call({ action: 'ms_preview', id: F })).status).toBe(503);
    expect(w.previews.size).toBe(0);
    w.fail.put = false;
    w.fail.sign = true;
    expect((await w.call({ action: 'ms_preview', id: F })).status).toBe(503);
    expect(w.objects.size + w.previews.size).toBe(0);
  });

  it('限流：ms_preview 每人每小时 20 次，第 21 次 429；过了这个小时又能用', async () => {
    const w = world();
    await w.seed(F, 'pptx', PPTX);
    for (let i = 0; i < VAULT_PREVIEW_RATE_PER_HOUR; i++) {
      if (i % 25 === 24) w.advance(60_000);
      expect((await w.call({ action: 'ms_preview', id: F })).status).toBe(200);
    }
    expect((await w.call({ action: 'ms_preview', id: F })).json).toEqual({ error: 'rate_limited' });
    w.advance(3600_000);
    expect((await w.call({ action: 'ms_preview', id: F })).status).toBe(200);
  });
});

describe('sweep', () => {
  const PPTX = new TextEncoder().encode('PK fake pptx body');
  const sweep = (w: ReturnType<typeof world>, secret: string | null = CRON) =>
    w.call({ action: 'sweep' }, { token: null, h: secret ? { 'x-cron-secret': secret } : {} });

  it('要 x-cron-secret：没有、不对都拒，不碰桶', async () => {
    const w = world();
    expect((await sweep(w, null)).status).toBe(401);
    expect((await sweep(w, 'x'.repeat(40))).status).toBe(401);
    expect(w.beats).toEqual([]);
  });

  it('登记后、写对象前中断（对象和登记都留下）：过期后 sweep 照样删对象和登记，写心跳', async () => {
    const w = world();
    await w.seed(F, 'pptx', PPTX);
    w.fail.sign = true;
    w.fail.remove = true;   // 清理也失败：模拟进程中途没了
    expect((await w.call({ action: 'ms_preview', id: F })).status).toBe(503);
    expect(w.objects.size).toBe(1);
    expect(w.previews.size).toBe(1);
    w.fail.sign = false;
    w.fail.remove = false;
    expect((await sweep(w)).json).toMatchObject({ ok: true, expired: 0 });
    expect(w.objects.size).toBe(1);   // 还没过期，不动
    w.advance(VAULT_PREVIEW_TTL_S * 1000);
    expect((await sweep(w)).json).toEqual({ ok: true, expired: 1, stray: 0, failed: 0 });
    expect(w.objects.size + w.previews.size).toBe(0);
    expect(w.beats.at(-1)).toEqual({ expired: 1, stray: 0, failed: 0 });
  });

  it('桶里没登记的对象：早于有效期 + 2 分钟才删，年轻的（可能刚登记还没写完）不动', async () => {
    const w = world();
    w.objects.set('a'.repeat(32) + '.pptx', { body: PPTX, created_at: w.now() });
    w.advance(VAULT_PREVIEW_TTL_S * 1000 + STRAY_GRACE_MS - 1);
    w.objects.set('b'.repeat(32) + '.pptx', { body: PPTX, created_at: w.now() });
    expect((await sweep(w)).json).toMatchObject({ stray: 0 });
    w.advance(2);
    expect((await sweep(w)).json).toMatchObject({ stray: 1 });
    expect([...w.objects.keys()]).toEqual(['b'.repeat(32) + '.pptx']);
  });

  it('写心跳失败只记 heartbeat_failed，照样回 200', async () => {
    const w = world();
    w.deps.store!.heartbeat = async () => { throw new Error('db'); };
    expect((await sweep(w)).status).toBe(200);
    expect(w.logs).toContain('heartbeat_failed');
  });
});

describe('入口', () => {
  it('不是 POST 回 405；请求不合格 400；每人每分钟 30 次，第 31 次 429（键不带文件信息）', async () => {
    const w = world();
    expect((await handle(new Request('http://x/functions/v1/vault-file', { method: 'GET' }), w.deps)).status).toBe(405);
    expect((await w.call({ action: 'nope' })).status).toBe(400);
    for (let i = 0; i < VAULT_FILE_RATE_PER_MIN; i++) expect((await w.call({ action: 'list', note_id: N })).status).toBe(200);
    expect((await w.call({ action: 'list', note_id: N })).json).toEqual({ error: 'rate_limited' });
    expect([...w.rate.keys()].every((k) => /^vault-file-min:[0-9a-f-]{36}:\d{12}$/.test(k))).toBe(true);
  });

  it('钥匙没配好：回 503 try_later、记 misconfigured', async () => {
    const w = world();
    w.deps.master = null;
    expect((await w.call({ action: 'list', note_id: N })).json).toEqual({ error: 'try_later' });
    expect(w.logs).toEqual(['misconfigured']);
  });

  it('日志只记结果码：上传、读取、预览以后日志里没有文件名、路径、user_id', async () => {
    const w = world();
    await w.upload({ name: '秘密合同.pdf' });
    await w.call({ action: 'get', id: F });
    w.rows.get(F)!.sha256 = 'x';
    await w.call({ action: 'get', id: F });
    expect(w.logs.every((c) => /^[a-z_]+$/.test(c))).toBe(true);
  });

  it('预览有效期和普通 PPT 给微软的签名一样（functions/_lib/files-rules.ts 的 TTL.ms）', () => {
    expect(VAULT_PREVIEW_TTL_S).toBe(TTL.ms);
  });

  describe('账号停用（TC-B1-10）', () => {
    const denied = () => {
      const w = world();
      w.deps.authenticate = async () => ({ ok: false, response: new Response('{"error":"account_disabled"}', { status: 403, headers: { 'content-type': 'application/json' } }) });
      return w;
    };
    it('TC-B1-10 vault-file：管理员停用的账号回 403 account_disabled，不验令牌、不碰库', async () => {
      const w = denied();
      let checked = 0;
      w.deps.checkToken = async () => { checked++; return { verdict: 'ok' }; };
      const r = await w.call({ action: 'list', note_id: N });
      expect([r.status, r.json?.error]).toEqual([403, 'account_disabled']);
      expect(checked).toBe(0);
    });
    it('TC-B1-10 vault-file：没有 profiles 行的账号回 403 account_disabled，不写对象', async () => {
      const w = denied();
      const r = await w.upload();
      expect([r.status, r.json.error]).toEqual([403, 'account_disabled']);
      expect(w.r2.objs.size + w.rows.size).toBe(0);
    });
  });
});

describe('密钥 ENC_KEY_ID', () => {
  it('上传写的 enc_key_id 是当前那一把', async () => {
    const w = world();
    await w.upload();
    expect((w.rows.get(F) as unknown as { enc_key_id: number }).enc_key_id).toBe(ENC_KEY_ID);
  });
});
