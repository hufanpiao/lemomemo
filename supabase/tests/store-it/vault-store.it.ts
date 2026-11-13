// B5 隐私记 store-it 第一组（vault 函数 store.ts 的 SQL 第一次上真库）：按 vault/index.ts 的组装方式（vault-harness.ts），
//   真 requireActiveUser、真 take_rate、真 store.ts，事务切到 fn_vault（表、列授权和会话变量版 RLS 都按 fn_vault 判）。入口 run.mjs。
// 覆盖：
//   ① 密码：status → setup（再 setup 409）→ unlock 连错 5 次锁定（第 5 次回 423 pin_locked、lock_level 1、locked_until 约 60 秒、推送 locked）→ 锁定中输对也 423
//      → 到期后输对清零；change_pin：pin_epoch + 1、vault_credentials 和 device_secrets 清空、旧令牌 vault_relock；
//      reset（真 JWT 的 amr otp 在 10 分钟内）：pin_epoch 再 + 1、last_reset_at、重设邮件、logs 一条 vault_reset（src vault）；
//   ② WebAuthn：挑战存进 webauthn_challenges（r. / u. 前缀）、验过即删；凭据登记（bytea 公钥、bigint sign_count）、列出、解锁后 sign_count 写回、删除；
//   ③ 隐私记：save 新建（body_enc 写入、title/body 为空、过 notes 的 check 约束）、修改、同 id 的普通随手记 404；add_images 预登记后经 vault-image 上传
//      （没登记 404、字节数不符 400、note_id 不符 404、登记了没传 get 404）、remove_images 软删；delete / undelete；list 解密；purge 经 purge_vault_impl 只删已删的那条；
//   ④ 隔离：B 的令牌、B 的身份碰不到 A 的行（delete 404、purge 0、list 看不到、同 id save 不覆盖）；purge_vault_impl 的 p_user 和 app.uid 不同时拒绝。
import { FakeAuthenticator } from '../../../tests/functions/webauthn-sim.ts';
import { vaultImageKey } from '../../functions/_shared/gen/schema/vault.ts';
import { vaultStore } from '../../functions/vault/store.ts';
import { assert, assertEquals, emails, fakeS3, healLeftovers, jwtOf, mails, mkUser, one, ours, purgeTraces, releaseLock, s3Server, sql, writeLedger } from './harness.ts';
import { asRole, callVault, closeVaultHarness, expectStatus, getImage, okVault, ORIGIN, pushes, settle, uploadImage, WEBP } from './vault-harness.ts';

const opts = { sanitizeOps: false, sanitizeResources: false };
const RP = 'localhost';   // 本机环境的 RP ID（webauthn-verify.ts 的 rpIdFor）
let A = '', B = '', jwtA = '', jwtB = '', tokA = '', tokB = '';
const vaultRow = async (uid: string) =>
  one(await sql<{ pin_epoch: number; fail_count: number; lock_level: number; lu: number | null; lr: number | null }[]>`
    select pin_epoch, fail_count, lock_level, (extract(epoch from locked_until - now()))::float8 as lu,
      (extract(epoch from now() - last_reset_at))::float8 as lr from private.vault where user_id = ${uid}`);

Deno.test({ name: '隐私记 store-it 开跑：清上次残留、建 A、B 两个人', ...opts, async fn() {
  await healLeftovers();
  A = await mkUser('vault-a');
  B = await mkUser('vault-b');
  jwtA = await jwtOf(A);
  jwtB = await jwtOf(B);
} });

Deno.test({ name: '① 密码：setup、连错 5 次锁定、锁定中 423、到期输对清零', ...opts, async fn() {
  assertEquals((await okVault(jwtA, { action: 'status' }, null, 'status')).set, false);
  tokA = String((await okVault(jwtA, { action: 'setup', pin: '1234' }, null, 'setup')).vault_token);
  expectStatus(await callVault(jwtA, { action: 'setup', pin: '1234' }), 409, '第二次 setup');
  assertEquals((await vaultRow(A)).pin_epoch, 0);
  for (let i = 1; i <= 4; i++) {
    const r = await callVault(jwtA, { action: 'unlock', pin: '0000' });
    expectStatus(r, 403, `第 ${i} 次输错`);
    assertEquals(r.json?.left, 5 - i);
  }
  const fifth = await callVault(jwtA, { action: 'unlock', pin: '0000' });
  expectStatus(fifth, 423, '第 5 次输错：锁上那一次就回 423（整块评审第 6 条）');
  assertEquals([fifth.json?.error, fifth.json?.retry_after_s], ['pin_locked', 60]);
  const v = await vaultRow(A);
  assertEquals([v.fail_count, v.lock_level], [0, 1], '锁上以后');
  assert(v.lu !== null && v.lu > 50 && v.lu <= 60, `locked_until 约 60 秒后：${v.lu}`);
  await settle();
  assert(pushes.some((p) => p.user === A && p.event === 'locked'), '锁定推送本人');
  expectStatus(await callVault(jwtA, { action: 'unlock', pin: '1234' }), 423, '锁定中输对');
  await sql`update private.vault set locked_until = now() - interval '1 second' where user_id = ${A}`;
  tokA = String((await okVault(jwtA, { action: 'unlock', pin: '1234' }, null, '到期后输对')).vault_token);
  const w = await vaultRow(A);
  assertEquals([w.fail_count, w.lock_level, w.lu], [0, 0, null], '输对清零');
  const st = await okVault(jwtA, { action: 'status' }, null, 'status');
  assertEquals([st.set, st.locked_until, st.webauthn], [true, null, 0]);
} });

Deno.test({ name: '② WebAuthn：挑战存取删、凭据登记 / 列出 / 删除、解锁后 sign_count 写回', ...opts, async fn() {
  const auth = await FakeAuthenticator.make();
  const o = await okVault(jwtA, { action: 'webauthn_options', purpose: 'register' }, null, 'options register');
  assertEquals(o.rp_id, RP);
  const challenge = String(o.challenge);
  const ch = one(await sql<{ user_id: string; left: number }[]>`select user_id::text, (extract(epoch from expires_at - now()))::float8 as left
    from private.webauthn_challenges where challenge = ${`r.${challenge}`}`);
  assert(ch.user_id === A && ch.left > 100 && ch.left <= 120, `挑战行：${JSON.stringify(ch)}`);
  const reg = await okVault(jwtA, { action: 'webauthn_register', pin: '1234', label: ' iPhone ', attestation: await auth.attest(challenge, { origin: ORIGIN, rpId: RP }) }, tokA, '登记');
  tokA = String(reg.vault_token);
  assertEquals((await sql`select 1 from private.webauthn_challenges where challenge = ${`r.${challenge}`}`).length, 0, '验过的挑战已删');
  const cred = one(await sql<{ credential_id: string; n: number; label: string; pk: number }[]>`select credential_id, sign_count::int as n, device_label as label,
    octet_length(public_key) as pk from private.vault_credentials where user_id = ${A}`);
  assertEquals([cred.credential_id, cred.n, cred.label], [auth.idB64, 0, 'iPhone']);
  assert(cred.pk > 60, `公钥按 bytea 存进去了（${cred.pk} 字节）`);
  const listed = await okVault(jwtA, { action: 'list_credentials' }, tokA, '列出凭据');
  assertEquals(listed.items, [{ id: auth.idB64, label: 'iPhone' }]);

  const u = await okVault(jwtA, { action: 'webauthn_options', purpose: 'unlock' }, null, 'options unlock');
  assertEquals(u.credential_ids, [auth.idB64]);
  const assertion = await auth.assert(String(u.challenge), { origin: ORIGIN, rpId: RP, countDelta: 3 });
  tokA = String((await okVault(jwtA, { action: 'unlock_webauthn', assertion }, null, '生物识别解锁')).vault_token);
  assertEquals(one(await sql<{ n: number }[]>`select sign_count::int as n from private.vault_credentials where credential_id = ${auth.idB64}`).n, 3, 'sign_count 写回');
  expectStatus(await callVault(jwtA, { action: 'unlock_webauthn', assertion }), 403, '同一个挑战第二次');

  const auth2 = await FakeAuthenticator.make();
  const o2 = await okVault(jwtA, { action: 'webauthn_options', purpose: 'register' }, null, 'options register 2');
  tokA = String((await okVault(jwtA, { action: 'webauthn_register', pin: '1234', label: '', attestation: await auth2.attest(String(o2.challenge), { origin: ORIGIN, rpId: RP }) }, tokA, '登记第二个')).vault_token);
  assertEquals((await okVault(jwtA, { action: 'status' }, null, 'status')).webauthn, 2);
  tokA = String((await okVault(jwtA, { action: 'remove_credential', credential_id: auth2.idB64 }, tokA, '删第二个')).vault_token);
  expectStatus(await callVault(jwtA, { action: 'remove_credential', credential_id: auth2.idB64 }, tokA), 404, '再删一次');
} });

Deno.test({ name: '① change_pin：pin_epoch + 1、凭据和设备盐清空、旧令牌失效；reset：再 + 1、邮件、logs', ...opts, async fn() {
  const dev = crypto.randomUUID();
  await sql`insert into public.devices (id, user_id, platform, label) values (${dev}, ${A}, 'web', 'store-it')`;
  await sql`insert into private.device_secrets (device_id, user_id, draft_salt, enc_key_id) values (${dev}, ${A}, ${new Uint8Array(32)}, 1)`;
  const old = tokA;
  tokA = String((await okVault(jwtA, { action: 'change_pin', old_pin: '1234', new_pin: '5678' }, tokA, '改密码')).vault_token);
  assertEquals((await vaultRow(A)).pin_epoch, 1);
  assertEquals((await sql`select 1 from private.vault_credentials where user_id = ${A}`).length, 0, '凭据清空');
  assertEquals((await sql`select 1 from private.device_secrets where user_id = ${A}`).length, 0, '设备盐清空');
  const relock = await callVault(jwtA, { action: 'list' }, old);
  expectStatus(relock, 401, '旧令牌');
  assertEquals(relock.json?.error, 'vault_relock');
  expectStatus(await callVault(jwtA, { action: 'unlock', pin: '1234' }), 403, '旧密码');
  await okVault(jwtA, { action: 'unlock', pin: '5678' }, null, '新密码');

  const before = mails.length;
  tokA = String((await okVault(jwtA, { action: 'reset', new_pin: '9999' }, null, '重设')).vault_token);
  await settle();
  const v = await vaultRow(A);
  assertEquals(v.pin_epoch, 2);
  assert(v.lr !== null && v.lr >= 0 && v.lr < 60, `last_reset_at 是刚才：${v.lr}`);
  assert(mails.slice(before).includes(emails.get(A) ?? '?'), '重设邮件发给本人');
  assertEquals((await sql`select 1 from public.logs where user_id = ${A} and act = 'vault_reset' and src = 'vault'`).length, 1, 'logs 一条');
  assert(pushes.some((p) => p.user === A && p.event === 'reset') && pushes.some((p) => p.user === A && p.event === 'pin_changed'), '改密码、重设都推送');
} });

const N1 = crypto.randomUUID(), N2 = crypto.randomUUID(), PLAIN = crypto.randomUUID(), IMG1 = crypto.randomUUID(), IMG2 = crypto.randomUUID();
type NoteDb = { is_private: boolean; title: string | null; body: string | null; enc: number | null; enc_key_id: number | null; deleted_at: number | null; category_source: string };
const noteDb = async (id: string) => (await sql<NoteDb[]>`select is_private, title, body, octet_length(body_enc) as enc, enc_key_id, deleted_at::float8 as deleted_at,
  category_source from public.notes where id = ${id}`)[0];

Deno.test({ name: '③ 隐私记：save 新建 / 修改、add_images 预登记再上传、remove_images、delete / undelete、list 解密、purge', ...opts, async fn() {
  const t0 = Date.now();
  tokA = String((await okVault(jwtA, { action: 'save', id: N1, title: '标题一', body: '正文一', category_id: null, created_at: t0, updated_at: t0 }, tokA, 'save 新建')).vault_token);
  const n = await noteDb(N1);
  assert(n && n.is_private && n.title === null && n.body === null && (n.enc ?? 0) > 16 && n.enc_key_id !== null, `新建的隐私记：${JSON.stringify(n)}`);
  tokA = String((await okVault(jwtA, { action: 'save', id: N1, title: '标题二', body: '正文二', category_id: null, created_at: t0, updated_at: t0 + 1 }, tokA, 'save 修改')).vault_token);
  tokA = String((await okVault(jwtA, { action: 'save', id: N2, title: '', body: '第二条', category_id: null, created_at: t0, updated_at: t0 }, tokA, 'save 第二条')).vault_token);
  await sql`insert into public.notes (id, user_id, title, body, created_at, updated_at) values (${PLAIN}, ${A}, 'p', 'plain', ${t0}, ${t0})`;
  expectStatus(await callVault(jwtA, { action: 'save', id: PLAIN, title: 'x', body: 'y', category_id: null, created_at: t0, updated_at: t0 }, tokA), 404, '同 id 的普通随手记');
  assertEquals((await noteDb(PLAIN))?.body, 'plain', '普通随手记没被覆盖');

  // 预登记（11-14 整块评审第 3 条）：先 save 登记行（过 row_quota、media_quota_guard），再经 vault-image 上传，字节数必须等于登记的 bytes
  expectStatus(await uploadImage(jwtA, tokA, N1, IMG1), 404, '没登记的图不能传');
  const add = { id: IMG1, bytes: WEBP.length, width: 3, height: 4, has_thumb: false };
  tokA = String((await okVault(jwtA, { action: 'save', id: N1, title: '标题二', body: '正文二', category_id: null, created_at: t0, updated_at: t0 + 2,
    add_images: [add, { ...add, id: IMG2, bytes: 999 }] }, tokA, 'add_images 预登记')).vault_token);
  assertEquals((await getImage(jwtA, tokA, IMG1)).status, 404, '登记了还没传：get 404');
  expectStatus(await uploadImage(jwtA, tokA, N1, IMG2), 400, '字节数和登记的不符');
  expectStatus(await uploadImage(jwtA, tokA, N2, IMG1), 404, 'note_id 对不上');
  expectStatus(await uploadImage(jwtA, tokA, N1, IMG1, 'thumb'), 404, '登记时没有缩略图');
  expectStatus(await uploadImage(jwtA, tokA, N1, IMG1), 200, '上传原图');
  const got = await getImage(jwtA, tokA, IMG1);
  assertEquals([got.status, [...got.bytes]], [200, [...WEBP]], '读回');
  tokA = String((await okVault(jwtA, { action: 'save', id: N1, title: '标题二', body: '正文二', category_id: null, created_at: t0, updated_at: t0 + 2,
    remove_images: [IMG2] }, tokA, '删掉没传成的那张')).vault_token);
  const img = one(await sql<{ bucket: string; bytes: number; ai_status: string; skip_reason: string; path: string; deleted_at: number | null }[]>`
    select bucket, bytes, ai_status, skip_reason, path, deleted_at from public.note_images where id = ${IMG1}`);
  assertEquals([img.bucket, img.bytes, img.ai_status, img.skip_reason, img.path, img.deleted_at], ['vault-images', WEBP.length, 'skip', 'vault_off', `${A}/${N1}/${IMG1}.webp`, null]);

  let list = await okVault(jwtA, { action: 'list' }, tokA, 'list');
  tokA = String(list.vault_token);
  const items = list.notes as { id: string; title: string; body: string; deleted_at: number | null; images: { id: string; bytes: number; deleted_at: number | null }[] }[];
  assertEquals(items.map((x) => [x.id, x.title, x.body]).sort(), [[N1, '标题二', '正文二'], [N2, '', '第二条']].sort(), 'list 解密');
  const imgs1 = items.find((x) => x.id === N1)?.images ?? [];
  assertEquals(imgs1.filter((i) => i.deleted_at === null).map((i) => [i.id, i.bytes]), [[IMG1, WEBP.length]], '没删的图');
  assert(imgs1.some((i) => i.id === IMG2 && i.deleted_at !== null), '删掉的那张带 deleted_at（list 照旧带已删的图）');

  tokA = String((await okVault(jwtA, { action: 'save', id: N1, title: '标题二', body: '正文二', category_id: null, created_at: t0, updated_at: t0 + 3, remove_images: [IMG1] }, tokA, 'remove_images')).vault_token);
  assert((await sql`select deleted_at from public.note_images where id = ${IMG1}`)[0]?.deleted_at !== null, '图片软删');
  await settle();
  assert(!fakeS3.objects.has(`vault-images/${vaultImageKey(A, N1, IMG1, 'full')}`), 'remove_images 提交后删掉 R2 对象（整块评审第 2 条）');

  tokA = String((await okVault(jwtA, { action: 'delete', id: N1 }, tokA, 'delete')).vault_token);
  assert((await noteDb(N1))?.deleted_at !== null, '软删');
  expectStatus(await callVault(jwtA, { action: 'save', id: N1, title: 'x', body: 'y', category_id: null, created_at: t0, updated_at: t0 + 4 }, tokA), 404, '已删的不能改');
  tokA = String((await okVault(jwtA, { action: 'undelete', id: N1 }, tokA, 'undelete')).vault_token);
  assertEquals((await noteDb(N1))?.deleted_at, null);
  tokA = String((await okVault(jwtA, { action: 'delete', id: N1 }, tokA, '再 delete')).vault_token);
  list = await okVault(jwtA, { action: 'list' }, tokA, 'list 回收站');
  assert((list.notes as { id: string; deleted_at: number | null }[]).find((x) => x.id === N1)?.deleted_at !== null, 'list 里带 deleted_at');
  const p = await okVault(jwtA, { action: 'purge', items: [N1, N2] }, tokA, 'purge');
  tokA = String(p.vault_token);
  assertEquals(p.purged, 1, '只删已删的那条');
  assertEquals(await noteDb(N1), undefined, 'N1 永久删除');
  assertEquals((await sql`select 1 from public.note_images where id = ${IMG1}`).length, 0, '图片行随外键删掉');
  assert((await noteDb(N2))?.is_private === true, 'N2 还在');
} });

Deno.test({ name: '④ 隔离：B 的令牌和身份碰不到 A 的行；purge_vault_impl 的 p_user ≠ app.uid 拒绝', ...opts, async fn() {
  tokB = String((await okVault(jwtB, { action: 'setup', pin: '4321' }, null, 'B setup')).vault_token);
  expectStatus(await callVault(jwtB, { action: 'list' }, tokA), 401, 'B 的 JWT 带 A 的令牌');
  expectStatus(await callVault(jwtA, { action: 'list' }, tokB), 401, 'A 的 JWT 带 B 的令牌');
  const lb = await okVault(jwtB, { action: 'list' }, tokB, 'B list');
  tokB = String(lb.vault_token);
  assertEquals(lb.notes, [], 'B 看不到 A 的隐私记');
  expectStatus(await callVault(jwtB, { action: 'delete', id: N2 }, tokB), 404, 'B 删 A 的');
  const pb = await okVault(jwtB, { action: 'purge', items: [N2] }, tokB, 'B purge A 的');
  tokB = String(pb.vault_token);
  assertEquals(pb.purged, 0);
  const t = Date.now();
  const sv = await callVault(jwtB, { action: 'save', id: N2, title: 'x', body: 'y', category_id: null, created_at: t, updated_at: t }, tokB);
  assert(sv.status !== 200, `B 用 A 的 id save 不能成功：${sv.status}`);
  const n2 = await noteDb(N2);
  assert(n2?.is_private === true && n2.deleted_at === null, 'A 的 N2 没动');
  assertEquals((await sql`select user_id::text as u from public.notes where id = ${N2}`)[0]?.u, A);
  // store 层直接看：B 的事务里读不到 A 的 vault、notes
  const seen = await asRole('fn_vault', B, async (tx) => {
    const s = vaultStore(tx as never, B);
    return { note: await s.note(N2), vault: (await tx`select count(*)::int as n from private.vault`)[0]?.n };
  });
  assertEquals(seen, { note: null, vault: 1 }, 'B 只看得到自己那一行 private.vault');
  let refused = '';
  await asRole('fn_vault', B, (tx) => vaultStore(tx as never, A).purge([N2])).catch((e) => { refused = String((e as Error).message); });
  assert(refused.includes('uid_mismatch'), `p_user 和 app.uid 不同：${refused}`);
  assert((await noteDb(N2))?.is_private === true, 'N2 还在');
} });

Deno.test({ name: '隐私记 store-it 收尾：删掉本次建的用户和留下的行', ...opts, async fn() {
  try {
    await settle();
    await purgeTraces(ours);
    await writeLedger([]);
    assertEquals((await sql`select count(*)::int as n from pg_auth_members m join pg_roles r on r.oid = m.roleid
      where r.rolname in ('fn_vault', 'fn_ai') and m.set_option and m.member = (select oid from pg_roles where rolname = current_user)`)[0]?.n, 0,
      '没在库里留下能切角色的成员关系（PG16 建角色时自带的 admin 成员关系 set_option 为 false，不算）');
  } finally {
    await closeVaultHarness();
    await releaseLock();
    await sql.end({ timeout: 5 });
    await s3Server.shutdown();
  }
} });
