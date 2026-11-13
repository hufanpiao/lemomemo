// B5 隐私记 store-it 第二组：移进移出（vault 的 import / export，move.ts 三步 + store.ts）、vault-image 上传读取（fn_ai，store.ts）、
//   account 带隐私记令牌导出（pin_epoch 经 fn_vault 读）、account rebind_device（service role 经 PostgREST rpc）。组装和切角色见 vault-harness.ts。
// 覆盖：
//   ⑤ import：普通随手记带明文、raw_text、tags、ai_meta 和一张有拍摄时间、AI 描述的图，另有旧向量 → 隐私记：明文列全清、body_enc 写入；
//      图片行换 vault-images、taken_at / ai_desc / ai_tags 清空、ai_status skip；R2 对象从 images 搬到 vault-images；旧向量删掉；list 解得开；
//      vault-image：往这条隐私记先 save 预登记、再传一张图（R2 里有、Content-Type image/webp），读回字节一样；别人的令牌、普通随手记都拒；
//      export 反过来：明文写回、bucket images、ai_status pending、对象搬回、这张图的 vault_ai 删掉；带 note_files 的普通随手记 import 回 409 has_files；
//   ⑥ account export：带有效令牌时隐私记那条只有密文列和中性列（没有 title、body），隐私记图片行没有 taken_at；不带令牌整行不进、vault 是 omitted；
//   ⑦ rebind_device（TC-B1-85 ⑩）：直连数据库调 rebind_device_impl 被拒（rebind_denied，role 不是 service_role）；
//      经 account 处理函数（PostgREST rpc）成功一次，devices 行换成新会话、旧会话被吊销（旧 JWT 401）；同一天第 11 次 429 rate_limited。
import { vaultImageKey } from '../../functions/_shared/gen/schema/vault.ts';
import { assert, assertEquals, callAccount, fakeS3, healLeftovers, jwtOf, mkUser, one, ours, purgeTraces, releaseLock, s3Has, s3Server, sql, writeLedger } from './harness.ts';
import { callVault, closeVaultHarness, exportWithToken, expectStatus, getImage, okVault, s3PutBytes, uploadImage, WEBP } from './vault-harness.ts';

const opts = { sanitizeOps: false, sanitizeResources: false };
let C = '', D = '', jwtC = '', jwtD = '', tokC = '', tokD = '';
const P1 = crypto.randomUUID(), P2 = crypto.randomUUID(), IMG = crypto.randomUUID(), IMG_NEW = crypto.randomUUID(), FILE = crypto.randomUUID();
const vec = `(select array_fill(0.1::real, array[768])::extensions.vector::extensions.halfvec)`;

Deno.test({ name: '隐私记移进移出 store-it 开跑：清上次残留、建 C、D', ...opts, async fn() {
  await healLeftovers();
  C = await mkUser('vault-c');
  D = await mkUser('vault-d');
  jwtC = await jwtOf(C);
  jwtD = await jwtOf(D);
  tokC = String((await okVault(jwtC, { action: 'setup', pin: '1234' }, null, 'C setup')).vault_token);
  tokD = String((await okVault(jwtD, { action: 'setup', pin: '1234' }, null, 'D setup')).vault_token);
} });

type Row = Record<string, unknown>;
const noteOf = async (id: string) => one(await sql<Row[]>`select is_private, title, body, raw_text, tags, ai_meta, converted_to,
  octet_length(body_enc) as enc, enc_key_id from public.notes where id = ${id}`);
const imgOf = async (id: string) => one(await sql<Row[]>`select bucket, taken_at, ai_desc, ai_tags, ai_status, skip_reason from public.note_images where id = ${id}`);

Deno.test({ name: '⑤ import：明文列清空、图片换桶并清拍摄时间和 AI 描述、R2 搬家、旧向量删掉；list 解得开', ...opts, async fn() {
  const t = Date.now();
  await sql`insert into public.notes (id, user_id, title, body, raw_text, tags, ai_meta, ai_status, created_at, updated_at)
    values (${P1}, ${C}, '旧标题', '旧正文', '旧原文', '{a,b}', '{"k":1}'::jsonb, 'done', ${t}, ${t})`;
  await sql`insert into public.note_images (id, user_id, note_id, bucket, path, bytes, taken_at, has_thumb, ai_status, ai_desc, ai_tags)
    values (${IMG}, ${C}, ${P1}, 'images', ${`${C}/${P1}/${IMG}.webp`}, ${WEBP.length}, ${t}, true, 'done', '一张猫', '{猫}')`;
  s3PutBytes('images', vaultImageKey(C, P1, IMG, 'full'), WEBP);
  s3PutBytes('images', vaultImageKey(C, P1, IMG, 'thumb'), WEBP);
  await sql`insert into private.note_vectors (user_id, kind, source_id, note_id, model, content_hash, embedding)
    values (${C}, 'note', ${P1}, ${P1}, 'store-it', 'h', ${sql.unsafe(vec)})`;
  await sql`insert into private.note_vectors (user_id, kind, source_id, image_id, model, content_hash, embedding)
    values (${C}, 'image', ${IMG}, ${IMG}, 'store-it', 'h', ${sql.unsafe(vec)})`;

  tokC = String((await okVault(jwtC, { action: 'import', note_id: P1 }, tokC, 'import')).vault_token);
  const n = await noteOf(P1);
  assertEquals([n.is_private, n.title, n.body, n.raw_text, n.tags, n.ai_meta, n.converted_to], [true, null, null, '', [], null, null], '明文列');
  assert(Number(n.enc) > 16 && n.enc_key_id !== null, '密文写进去了');
  assertEquals(await imgOf(IMG), { bucket: 'vault-images', taken_at: null, ai_desc: null, ai_tags: [], ai_status: 'skip', skip_reason: 'vault_off' });
  for (const part of ['full', 'thumb'] as const) {
    const key = vaultImageKey(C, P1, IMG, part);
    assert(s3Has('vault-images', key) && !s3Has('images', key), `${part} 搬进 vault-images`);
    assertEquals(fakeS3.objects.get(`vault-images/${key}`)?.contentType, 'image/webp', 'put 显式写 contentType');
  }
  assertEquals((await sql`select 1 from private.note_vectors where user_id = ${C} and model = 'store-it'`).length, 0, '旧向量删掉');
  const list = await okVault(jwtC, { action: 'list' }, tokC, 'list');
  tokC = String(list.vault_token);
  assertEquals((list.notes as Row[]).map((x) => [x.id, x.title, x.body]), [[P1, '旧标题', '旧正文']]);
} });

Deno.test({ name: '⑤ vault-image：传图、读回字节一样；别人的令牌、普通随手记、别人的图都拒', ...opts, async fn() {
  // 先 save 预登记，再上传（11-14 整块评审第 3 条）
  tokC = String((await okVault(jwtC, { action: 'save', id: P1, title: '旧标题', body: '旧正文', category_id: null, created_at: 1, updated_at: Date.now(),
    add_images: [{ id: IMG_NEW, bytes: WEBP.length, width: null, height: null, has_thumb: false }] }, tokC, 'save 预登记新图')).vault_token);
  expectStatus(await uploadImage(jwtC, tokC, P1, IMG_NEW), 200, '上传');
  const key = vaultImageKey(C, P1, IMG_NEW, 'full');
  assertEquals(fakeS3.objects.get(`vault-images/${key}`)?.contentType, 'image/webp');
  const got = await getImage(jwtC, tokC, IMG_NEW);
  assertEquals([got.status, got.type, [...got.bytes]], [200, 'image/webp', [...WEBP]], '读回');
  assertEquals((await getImage(jwtC, tokC, IMG)).status, 200, '搬进来的图也能读');
  expectStatus(await uploadImage(jwtC, tokD, P1, crypto.randomUUID()), 401, 'D 的令牌');
  assertEquals((await getImage(jwtD, tokD, IMG_NEW)).status, 404, 'D 读 C 的图');
  const plain = crypto.randomUUID();
  await sql`insert into public.notes (id, user_id, body, created_at, updated_at) values (${plain}, ${C}, 'x', 1, 1)`;
  expectStatus(await uploadImage(jwtC, tokC, plain, crypto.randomUUID()), 404, '传到普通随手记');
} });

Deno.test({ name: '⑤ export：明文写回、图片回 images、ai_status pending、对象搬回；带 note_files 的 import 回 has_files', ...opts, async fn() {
  await sql`insert into private.vault_ai (kind, source_id, user_id, image_id, desc_enc, tags_enc, enc_key_id)
    values ('image', ${IMG}, ${C}, ${IMG}, ${new Uint8Array([1])}, ${new Uint8Array([1])}, 1)`;
  tokC = String((await okVault(jwtC, { action: 'export', note_id: P1 }, tokC, 'export')).vault_token);
  assertEquals((await sql`select 1 from private.vault_ai where image_id = ${IMG}`).length, 0, '移出时删掉这张图的 vault_ai');
  const n = await noteOf(P1);
  assertEquals([n.is_private, n.title, n.body, n.enc, n.enc_key_id], [false, '旧标题', '旧正文', null, null]);
  assertEquals(await imgOf(IMG), { bucket: 'images', taken_at: null, ai_desc: null, ai_tags: [], ai_status: 'pending', skip_reason: null });
  for (const k of [vaultImageKey(C, P1, IMG, 'full'), vaultImageKey(C, P1, IMG, 'thumb'), vaultImageKey(C, P1, IMG_NEW, 'full')]) {
    assert(s3Has('images', k) && !s3Has('vault-images', k), `对象搬回 images：${k}`);
  }
  const t = Date.now();
  await sql`insert into public.notes (id, user_id, body, created_at, updated_at) values (${P2}, ${C}, '带附件', ${t}, ${t})`;
  await sql`insert into public.note_files (id, user_id, note_id, kind, path, name, mime, bytes, sha256, created_at, updated_at)
    values (${FILE}, ${C}, ${P2}, 'pdf', ${`${C}/${P2}/${FILE}.pdf`}, 'a.pdf', 'application/pdf', 10, ${'0'.repeat(64)}, ${t}, ${t})`;
  const hf = await callVault(jwtC, { action: 'import', note_id: P2 }, tokC);
  expectStatus(hf, 409, '带附件的 import');
  assertEquals(hf.json?.error, 'has_files');
  assertEquals((await noteOf(P2)).is_private, false);
  expectStatus(await callVault(jwtD, { action: 'import', note_id: P1 }, tokD), 404, 'D import C 的随手记');
} });

Deno.test({ name: '⑥ account export：带有效令牌时隐私记行只有密文列；不带令牌整行不进', ...opts, async fn() {
  tokC = String((await okVault(jwtC, { action: 'import', note_id: P1 }, tokC, '再 import 一次')).vault_token);
  const doc = await exportWithToken(jwtC, tokC);
  assertEquals(doc.vault, 'cipher');
  const tables = doc.tables as Record<string, Row[]>;
  const priv = (tables.notes ?? []).find((r) => r.id === P1);
  assert(priv, '导出里有这条隐私记');
  for (const k of ['title', 'body', 'raw_text', 'tags', 'ai_meta', 'converted_to']) assert(!(k in priv), `隐私记行不该有 ${k}`);
  assert(typeof priv.body_enc === 'string' && String(priv.body_enc).length > 10 && priv.is_private === true, `密文列在：${JSON.stringify(priv).slice(0, 200)}`);
  const img = (tables.note_images ?? []).find((r) => r.id === IMG);
  assert(img && img.bucket === 'vault-images' && !('taken_at' in img) && !('ai_desc' in img), `隐私记图片行：${JSON.stringify(img)}`);
  assert((tables.notes ?? []).some((r) => r.id === P2 && r.body === '带附件'), '普通随手记照常带明文');

  const none = await exportWithToken(jwtC, null);
  assertEquals(none.vault, 'omitted');
  const t2 = none.tables as Record<string, Row[]>;
  assert(!(t2.notes ?? []).some((r) => r.id === P1) && !(t2.note_images ?? []).some((r) => r.id === IMG), '不带令牌隐私记行一行不进');
} });

let APP: Record<string, string> = {};   // rebind_device 自己查版本（D9），不带会 426；取库里 app_config 的最低版本
const sessionOf = (jwt: string) => String((JSON.parse(atob((jwt.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'))) as { session_id?: string }).session_id);

Deno.test({ name: '⑦ rebind_device：直连被拒、经 PostgREST 成功一次并吊销旧会话、第 11 次 429', ...opts, async fn() {
  APP = { 'x-app-version': String(one(await sql<{ v: string | null }[]>`select min_client_version as v from public.app_config where id = 1`).v ?? '4.0.0') };
  const R = await mkUser('vault-rebind');
  const s1 = await jwtOf(R);
  const s2 = await jwtOf(R);
  const dev = crypto.randomUUID();
  await sql`insert into public.devices (id, user_id, platform, label, session_id) values (${dev}, ${R}, 'ios', 'store-it', ${sessionOf(s1)})`;
  let direct = '';
  await sql`select private.rebind_device_impl(${R}::uuid, ${dev}::uuid, ${sessionOf(s1)}::uuid, ${sessionOf(s2)}::uuid)`.catch((e) => { direct = String((e as Error).message); });
  assertEquals(direct, 'rebind_denied', '直连数据库（role 不是 service_role）交接一律失败');
  assertEquals(one(await sql<{ s: string }[]>`select session_id::text as s from public.devices where id = ${dev}`).s, sessionOf(s1), '直连没改动');

  const ok = await callAccount(s2, { action: 'rebind_device', device_id: dev, old_token: s1 }, APP);
  assertEquals([ok.status, ok.json], [200, { ok: true }], '经 account（PostgREST rpc）交接');
  assertEquals(one(await sql<{ s: string }[]>`select session_id::text as s from public.devices where id = ${dev}`).s, sessionOf(s2), 'devices 行换成新会话');
  assertEquals((await callAccount(s1, { action: 'status' })).status, 401, '旧会话被吊销');
  // 评审 M5：结果不确定时客户端会原样重发，设备行已经指向这次的新会话就幂等回 200（也算一次）
  const again = await callAccount(s2, { action: 'rebind_device', device_id: dev, old_token: s1 }, APP);
  assertEquals([again.status, again.json], [200, { ok: true }], '第 2 次原样重发：幂等成功');
  const s3 = await jwtOf(R);
  for (let i = 3; i <= 10; i++) {
    const r = await callAccount(s3, { action: 'rebind_device', device_id: dev, old_token: s1 }, APP);
    assertEquals(r.status, 409, `第 ${i} 次（另一个新会话拿已吊销的旧令牌，失败也算一次）`);
  }
  assertEquals(one(await sql<{ s: string }[]>`select session_id::text as s from public.devices where id = ${dev}`).s, sessionOf(s2), '失败的几次没改动设备行');
  const eleventh = await callAccount(s2, { action: 'rebind_device', device_id: dev, old_token: s1 }, APP);
  assertEquals([eleventh.status, eleventh.json?.error], [429, 'rate_limited'], '第 11 次');
} });

Deno.test({ name: '隐私记移进移出 store-it 收尾：删掉本次建的用户和留下的行', ...opts, async fn() {
  try {
    await purgeTraces(ours);
    await writeLedger([]);
  } finally {
    await closeVaultHarness();
    await releaseLock();
    await sql.end({ timeout: 5 });
    await s3Server.shutdown();
  }
} });
