// B4b-1 隐私记文档附件 store-it：vault-file 的 core.ts + store.ts 以 fn_vault 打真库（lemo-e2e），R2 用 harness 的假 S3，
//   vault-preview 用本地 Supabase 真 Storage（service role，同 vault-file/index.ts 的写法）。组装和切角色见 vault-harness.ts。
// 覆盖：
//   ① upload：本人隐私记上写进一行 is_vault、name 为空、sha256 是 HMAC、check_status ok、ai_status skip；对象进 vault-files（octet-stream）；
//      普通随手记 404、同 id 409、存储额度满了 403 quota_exceeded 且对象删掉（note_files_media_quota 触发器真判）；
//   ② list 解开名字、get 回原字节；remove、restore 改 deleted_at；
//   ③ ms_preview：private.vault_preview 登记一行（随机路径、不含 user_id）、Storage 里有对象、签名链接是 /sb 同源地址；ms_preview_end 两边都删；
//   ④ sweep：带 x-cron-secret，过期登记连对象一起删（含“登记了、对象没写成”的那种），经 scan_vault_preview 跨用户读；写心跳 vault-file-sweep。
import { noteFilePath, noteFileThumbPath } from '../../functions/_shared/gen/logic/files/media-path.ts';
import { sniffFile, zipBombCheck } from '../../functions/_shared/gen/logic/files/file-sniff.ts';
import { inflateRaw } from '../../functions/_shared/gen/logic/files/inflate.ts';
import { sanitizeFileName } from '../../functions/_shared/gen/logic/files/file-name.ts';
import { FILE_MAX_BYTES } from '../../functions/_shared/gen/logic/files/limits.ts';
import { DOC_TYPES, type DocKind } from '../../functions/_shared/gen/manifests/attachments.ts';
import {
  VAULT_FILE_RATE_PER_MIN, VAULT_FILE_THUMB_MAX_BYTES, VAULT_FILE_UPLOAD_MAX_BODY, VAULT_PREVIEW_RATE_PER_HOUR, VAULT_PREVIEW_TTL_S,
  vaultFileMeta, vaultFileRequest,
} from '../../functions/_shared/gen/schema/vault-file.ts';
import { pinEpoch } from '../../functions/_shared/vault-epoch.ts';
import { newDek, sealPart, sealText, shaMac, wrapDek } from '../../functions/_shared/vault-files.ts';
import { vaultTokenChecker } from '../../functions/_shared/vault-token.ts';
import { authResult, requireActiveUser } from '../../functions/_shared/auth.ts';
import { type Deps, handle, type Preview, type Rules } from '../../functions/vault-file/core.ts';
import { expiredPreviews, fileOf, filesOf, insertFile, previewsOf, privateNote, registerPreview, setDeleted, unregisterPreviews } from '../../functions/vault-file/store.ts';
import { admin, assert, assertEquals, fakeS3, healLeftovers, jwtOf, mkUser, one, ours, purgeTraces, releaseLock, s3Has, s3Server, sql, writeLedger } from './harness.ts';
import { asRole, closeVaultHarness, expectStatus, KEYS, logs, okVault, r2, s3PutBytes } from './vault-harness.ts';

const opts = { sanitizeOps: false, sanitizeResources: false };
const CRON = 'store-it-vault-file-cron-secret-only-local';
const PREVIEW_BUCKET = 'vault-preview';
let C = '', jwtC = '', tokC = '';
const N = crypto.randomUUID(), NP = crypto.randomUUID(), F1 = crypto.randomUUID(), F2 = crypto.randomUUID(), FP = crypto.randomUUID();
type Row = Record<string, unknown>;

const asKind = (k: string) => k as DocKind;
const RULES: Rules = {
  parse(v) { const p = vaultFileRequest.safeParse(v); return p.success ? p.data : null; },
  parseMeta(v) { const p = vaultFileMeta.safeParse(v); return p.success ? p.data : null; },
  sniff: (b) => sniffFile(b, inflateRaw),
  bomb: (b) => zipBombCheck(b, inflateRaw),
  sanitizeName: (raw, kind) => sanitizeFileName(raw, asKind(kind)),
  mime: (kind) => DOC_TYPES[asKind(kind)],
  fileKey: (u, n, id, kind) => noteFilePath(u, n, id, asKind(kind)),
  thumbKey: noteFileThumbPath,
  maxBytes: FILE_MAX_BYTES, thumbMaxBytes: VAULT_FILE_THUMB_MAX_BYTES, uploadMaxBody: VAULT_FILE_UPLOAD_MAX_BODY,
  ratePerMin: VAULT_FILE_RATE_PER_MIN, previewPerHour: VAULT_PREVIEW_RATE_PER_HOUR, previewTtlS: VAULT_PREVIEW_TTL_S,
};

// vault-preview：本地 Supabase 真 Storage（同 vault-file/index.ts 的 preview）
const bucket = () => admin.storage.from(PREVIEW_BUCKET);   // harness 的 admin 就是 service role
const preview: Preview = {
  async put(path, body, o) {
    const { error } = await bucket().upload(path, body, { contentType: o.contentType, cacheControl: '0', upsert: false });
    if (error) throw new Error(`preview_put ${error.message}`);
  },
  async sign(path, ttl) {
    const { data, error } = await bucket().createSignedUrl(path, ttl);
    if (error || !data?.signedUrl) throw new Error('preview_sign');
    const u = new URL(data.signedUrl);
    return `/sb${u.pathname}${u.search}`;
  },
  async remove(paths) { if (paths.length) { const { error } = await bucket().remove([...paths]); if (error) throw new Error('preview_remove'); } },
  async list() {
    const { data, error } = await bucket().list('', { limit: 1000 });
    if (error) throw new Error('preview_list');
    return (data ?? []).filter((o) => /^[0-9a-f]{32}\.pptx$/.test(o.name) && typeof o.created_at === 'string').map((o) => ({ name: o.name, created_at: Date.parse(o.created_at as string) }));
  },
};
const storageHas = async (path: string) => ((await bucket().list('', { limit: 1000, search: path })).data ?? []).some((o) => o.name === path);

const beats: Record<string, number>[] = [];
const deps: Deps = {
  authenticate: (r) => authResult(() => requireActiveUser(r, admin)),
  async takeRate(k, limit, windowS) {
    const { data, error } = await admin.schema('private').rpc('take_rate', { p_key: k, p_limit: limit, p_window_s: windowS });
    if (error || typeof data !== 'boolean') throw new Error('db');
    return data;
  },
  checkToken: vaultTokenChecker(KEYS.tokenSecret, Date.now, (uid) => asRole('fn_vault', uid, (tx) => pinEpoch(tx as never, uid)), (c) => logs.push(c)),
  cronSecret: CRON,
  master: KEYS.master,
  rules: RULES,
  store: {
    privateNote: (u, n) => asRole('fn_vault', u, (tx) => privateNote(tx as never, u, n)),
    file: (u, id) => asRole('fn_vault', u, (tx) => fileOf(tx as never, u, id)),
    files: (u, n) => asRole('fn_vault', u, (tx) => filesOf(tx as never, u, n)),
    insert: (u, row) => asRole('fn_vault', u, (tx) => insertFile(tx as never, u, row, noteFilePath(u, row.note_id, row.id, asKind(row.kind)))),
    setDeleted: (u, id, at) => asRole('fn_vault', u, (tx) => setDeleted(tx as never, u, id, at)),
    previews: (u) => asRole('fn_vault', u, (tx) => previewsOf(tx as never, u)),
    register: (u, p, f, e) => asRole('fn_vault', u, (tx) => registerPreview(tx as never, u, p, f, e)),
    unregister: (u, ps) => asRole('fn_vault', u, (tx) => unregisterPreviews(tx as never, u, ps)),
    expired: () => asRole('fn_vault', '', (tx) => expiredPreviews(tx as never)),
    async heartbeat(d) {
      beats.push(d);
      const { error } = await admin.schema('private').from('heartbeat').upsert({ name: 'vault-file-sweep', at: new Date().toISOString(), detail: d }, { onConflict: 'name' });
      if (error) throw new Error('heartbeat');
    },
  },
  r2,
  preview,
  random: (n) => crypto.getRandomValues(new Uint8Array(n)),
  now: Date.now,
  log: (c) => logs.push(c),
};

type Res = { status: number; json: Record<string, unknown> | null; bytes: Uint8Array | null };
async function call(body: unknown, h: Record<string, string> = {}): Promise<Res> {
  const res = await handle(new Request('http://127.0.0.1/functions/v1/vault-file', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwtC}`, 'x-vault-token': tokC, ...h }, body: JSON.stringify(body),
  }), deps);
  const isJson = (res.headers.get('content-type') ?? '').startsWith('application/json');
  return { status: res.status, json: isJson ? (await res.json()) as Record<string, unknown> : null, bytes: isJson ? null : new Uint8Array(await res.arrayBuffer()) };
}
const hexOf = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))].map((x) => x.toString(16).padStart(2, '0')).join('');
const pdf = (n: number, fill: number): Uint8Array<ArrayBuffer> => { const b = new Uint8Array(n).fill(fill); b.set([0x25, 0x50, 0x44, 0x46, 0x2d]); return b; };
async function upload(id: string, note: string, file: Uint8Array<ArrayBuffer>, name = 'a.pdf'): Promise<Res> {
  const fd = new FormData();
  fd.set('meta', JSON.stringify({ id, note_id: note, kind: 'pdf', name, sha256: await hexOf(file), bytes: file.length, pages: 1, text: '文字' }));
  fd.set('file', new Blob([file]));
  const tmp = new Request('http://x', { method: 'POST', body: fd });
  const buf = new Uint8Array(await tmp.arrayBuffer());
  const res = await handle(new Request('http://127.0.0.1/functions/v1/vault-file', {
    method: 'POST', headers: { authorization: `Bearer ${jwtC}`, 'x-vault-token': tokC, 'content-type': tmp.headers.get('content-type') ?? '', 'content-length': String(buf.length) }, body: buf,
  }), deps);
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, bytes: null };
}
const PDF1 = pdf(300, 3);

Deno.test({ name: 'vault-file store-it 开跑：清上次残留、建 C、一条隐私记、一条普通随手记', ...opts, async fn() {
  await healLeftovers();
  C = await mkUser('vault-file');
  jwtC = await jwtOf(C);
  tokC = String((await okVault(jwtC, { action: 'setup', pin: '1234' }, null, 'setup')).vault_token);
  tokC = String((await okVault(jwtC, { action: 'save', id: N, title: '隐私', body: '正文', category_id: null, created_at: 1, updated_at: 1 }, tokC, '建隐私记')).vault_token);
  await sql`insert into public.notes (id, user_id, body, created_at, updated_at) values (${NP}, ${C}, '普通', 1, 1)`;
} });

Deno.test({ name: '① upload：写进 is_vault 行、对象进 vault-files；普通随手记 404、同 id 409、额度满 403 且对象删掉', ...opts, async fn() {
  expectStatus(await upload(F1, N, PDF1, '合同.pdf'), 200, 'upload');
  const r = one(await sql<Row[]>`select is_vault, name, text_excerpt, sha256, check_status, ai_status, skip_reason, bytes, path,
    octet_length(name_enc) as ne, octet_length(dek_enc) as de, enc_key_id from public.note_files where id = ${F1}`);
  assertEquals([r.is_vault, r.name, r.text_excerpt, r.check_status, r.ai_status, r.skip_reason, r.bytes], [true, null, null, 'ok', 'skip', 'vault_off', PDF1.length], '行');
  assertEquals(r.sha256, await shaMac(KEYS.master, C, await hexOf(PDF1)), 'sha256 存 HMAC');
  assert(Number(r.ne) > 16 && Number(r.de) > 32 && r.enc_key_id === 1, '密文列齐全');
  const key = noteFilePath(C, N, F1, 'pdf');
  assertEquals(r.path, key);
  assert(s3Has('vault-files', key) && !s3Has('files', key), '对象在 vault-files');
  assertEquals(fakeS3.objects.get(`vault-files/${key}`)?.contentType, 'application/octet-stream');
  expectStatus(await upload(crypto.randomUUID(), NP, PDF1), 404, '普通随手记');
  expectStatus(await upload(F1, N, PDF1), 409, '同 id');
  await sql`insert into private.user_limits (user_id, media_mb) values (${C}, 0) on conflict (user_id) do update set media_mb = 0`;
  const q = await upload(F2, N, pdf(200, 4));
  await sql`delete from private.user_limits where user_id = ${C}`;
  expectStatus(q, 403, '额度满了');
  assertEquals(q.json?.error, 'quota_exceeded');
  assert(!s3Has('vault-files', noteFilePath(C, N, F2, 'pdf')), '额度满时对象删掉');
  assertEquals((await sql`select 1 from public.note_files where id = ${F2}`).length, 0);
} });

Deno.test({ name: '② list 解开名字、get 回原字节；remove、restore', ...opts, async fn() {
  const l = await call({ action: 'list', note_id: N });
  expectStatus(l, 200, 'list');
  assertEquals((l.json?.files as Row[]).map((f) => [f.id, f.name, f.bytes]), [[F1, '合同.pdf', PDF1.length]]);
  const g = await call({ action: 'get', id: F1 });
  expectStatus(g, 200, 'get');
  assertEquals([...(g.bytes ?? [])], [...PDF1], '原字节');
  expectStatus(await call({ action: 'remove', id: F1 }), 200, 'remove');
  assert(one(await sql<Row[]>`select deleted_at from public.note_files where id = ${F1}`).deleted_at !== null, '软删');
  expectStatus(await call({ action: 'get', id: F1 }), 404, '删了以后 get');
  expectStatus(await call({ action: 'restore', id: F1 }), 200, 'restore');
  assertEquals(one(await sql<Row[]>`select deleted_at from public.note_files where id = ${F1}`).deleted_at, null);
} });

Deno.test({ name: '③ ms_preview 登记 + 真 Storage 对象 + /sb 签名链接；ms_preview_end 两边都删', ...opts, async fn() {
  // PPTX 判型要真 ZIP，这里直接按 vault-file 的加密写法放一行和对象（只测预览）
  const plain = new TextEncoder().encode('PK store-it fake pptx');
  const dek = await newDek();
  const key = noteFilePath(C, N, FP, 'pptx');
  await sql`insert into public.note_files (id, user_id, note_id, kind, path, is_vault, mime, bytes, sha256, name_enc, dek_enc, enc_key_id,
      check_status, ai_status, skip_reason, created_at, updated_at)
    values (${FP}, ${C}, ${N}, 'pptx', ${key}, true, ${DOC_TYPES.pptx}, ${plain.length}, ${await shaMac(KEYS.master, C, await hexOf(plain))},
      ${await sealText(dek, C, FP, 'name', 'p.pptx')}, ${await wrapDek(KEYS.master, C, FP, dek)}, 1, 'ok', 'skip', 'vault_off', 1, 1)`;
  s3PutBytes('vault-files', key, await sealPart(dek, C, FP, 'file', plain));
  const r = await call({ action: 'ms_preview', id: FP });
  expectStatus(r, 200, 'ms_preview');
  const url = String(r.json?.url);
  assert(/^\/sb\/storage\/v1\/object\/sign\/vault-preview\/[0-9a-f]{32}\.pptx\?token=/.test(url) && !url.includes(C), `链接：${url.slice(0, 80)}`);
  const reg = await sql<Row[]>`select path, file_id from private.vault_preview where user_id = ${C}`;
  assertEquals(reg.length, 1, '登记一行');
  const path = String(reg[0]?.path);
  assert(url.includes(path) && !path.includes(C), '路径随机、不含 user_id');
  assert(await storageHas(path), 'Storage 里有对象');
  expectStatus(await call({ action: 'ms_preview_end' }), 200, 'ms_preview_end');
  assertEquals((await sql`select 1 from private.vault_preview where user_id = ${C}`).length, 0, '登记删了');
  assert(!(await storageHas(path)), 'Storage 对象删了');
} });

Deno.test({ name: '④ sweep：过期登记连对象一起删（含对象没写成的），跨用户经 scan_vault_preview；写心跳', ...opts, async fn() {
  expectStatus(await call({ action: 'ms_preview', id: FP }), 200, '再开一个预览');
  const path = String(one(await sql<Row[]>`select path from private.vault_preview where user_id = ${C}`).path);
  const orphan = `${'0'.repeat(31)}a.pptx`;   // 登记了、对象没写成（中途断了）
  await sql`insert into private.vault_preview (path, user_id, file_id, expires_at) values (${orphan}, ${C}, ${FP}, now() - interval '1 second')`;
  await sql`update private.vault_preview set expires_at = now() - interval '1 second' where path = ${path}`;
  expectStatus(await call({ action: 'sweep' }, { 'x-cron-secret': 'x'.repeat(40) }), 401, '密钥不对');
  const s = await call({ action: 'sweep' }, { 'x-cron-secret': CRON });
  expectStatus(s, 200, 'sweep');
  assert(Number(s.json?.expired) >= 2, `删掉的过期登记：${JSON.stringify(s.json)}`);
  assertEquals((await sql`select 1 from private.vault_preview where user_id = ${C}`).length, 0, '登记都删了');
  assert(!(await storageHas(path)), 'Storage 对象删了');
  const hb = one(await sql<Row[]>`select at > now() - interval '1 minute' as fresh from private.heartbeat where name = 'vault-file-sweep'`);
  assertEquals(hb.fresh, true, '心跳');
} });

Deno.test({ name: 'vault-file store-it 收尾：删掉本次建的用户和留下的行', ...opts, async fn() {
  try {
    const left = (await preview.list()).map((o) => o.name);
    if (left.length) await preview.remove(left);
    await purgeTraces(ours);
    await writeLedger([]);
  } finally {
    await closeVaultHarness();
    await releaseLock();
    await sql.end({ timeout: 5 });
    await s3Server.shutdown();
  }
} });
