// B4b-2 识图 store-it：ai-media/store.ts、file-check/store.ts 的 retryAi 第一次上真库（以 fn_ai 跑，切角色办法见 vault-harness.ts 的 asRole）。入口 run.mjs。
// 覆盖：
//   ① dueUsers（跨用户扫描视图）挑得到 E、F；dueItems 只回本人到期的 pending，分得出隐私记、最近删除、已经不在的随手记；
//   ② laterItems 推后（tries + 1）以后不再到期；parkAll 把全部 pending 推到同一时刻；
//   ③ skipConsent 只改普通图片、回写了哪几张，unskip 只改回这几张里还是 skip / consent 的；skipOther、failItem 只改 pending；
//   ④ doneItem 写回描述和标签，note_images_embed 触发器入 embed_queue；已不是 pending 的不写；
//   ⑤ file-check 的 retryAi：failed 改回 pending、ai_tries 清零，别的状态原样回，别人的回 null；
//   ⑥ writeHeartbeat 过 heartbeat 的 fn_ai_own 策略。
import { doneItem, dueItems, dueUsers, failItem, laterItems, parkAll, skipConsent, skipOther, unskip, writeHeartbeat } from '../../functions/ai-media/store.ts';
import { retryAi } from '../../functions/file-check/store.ts';
import { assert, assertEquals, healLeftovers, mkUser, purgeTraces, ours, releaseLock, s3Server, sql, writeLedger } from './harness.ts';
import { asRole, closeVaultHarness } from './vault-harness.ts';

const opts = { sanitizeOps: false, sanitizeResources: false };
let E = '', F = '';
const N1 = crypto.randomUUID(), NP = crypto.randomUUID(), ND = crypto.randomUUID(), NF = crypto.randomUUID();
const I1 = crypto.randomUUID(), I2 = crypto.randomUUID(), IP = crypto.randomUUID(), ID = crypto.randomUUID(), IV = crypto.randomUUID(), IF = crypto.randomUUID();
const ai = <T>(uid: string, fn: Parameters<typeof asRole<T>>[2]) => asRole<T>('fn_ai', uid, fn);
type Img = { ai_status: string; skip_reason: string | null; ai_tries: number; ai_next_at: number | null; ai_desc: string | null; ai_tags: string[] };
async function img(id: string): Promise<Img> {
  const [r] = await sql<Img[]>`select ai_status, skip_reason, ai_tries, ai_next_at::float8 as ai_next_at, ai_desc, ai_tags
    from public.note_images where id = ${id}`;
  assert(r, `图片 ${id} 在`);
  return r;
}

async function addImage(uid: string, note: string, id: string, bucket = 'images') {
  await sql`insert into public.note_images (id, user_id, note_id, bucket, path, bytes) values (${id}, ${uid}, ${note}, ${bucket}, ${`${uid}/${note}/${id}.webp`}, 1)`;
}

Deno.test({ name: '识图 store-it 开跑：清上次残留、建 E、F，各写随手记和图片', ...opts, async fn() {
  await healLeftovers();
  E = await mkUser('media-e');
  F = await mkUser('media-f');
  for (const [id, uid] of [[N1, E], [NP, E], [ND, E], [NF, F]] as const) {
    await sql`insert into public.notes (id, user_id, body, created_at, updated_at) values (${id}, ${uid}, 'n', 1, 1)`;
  }
  await sql`update public.notes set title = null, body = null, is_private = true, body_enc = '\x01', enc_key_id = 1 where id = ${NP}`;
  await sql`update public.notes set deleted_at = 1 where id = ${ND}`;
  await addImage(E, N1, I1);
  await addImage(E, N1, I2);
  await addImage(E, NP, IP);
  await addImage(E, ND, ID);
  await addImage(E, NP, IV, 'vault-images');
  await addImage(F, NF, IF);
} });

Deno.test({ name: '① 跨用户挑人、按人取到期图片，分得出隐私记和最近删除', ...opts, async fn() {
  const now = Date.now();
  const users = await ai('', (tx) => dueUsers(tx, 1000, now));
  assert(users.includes(E) && users.includes(F), `扫描视图挑得到 E、F：${users.length} 人`);
  const items = await ai(E, (tx) => dueItems(tx, E, 20, now));
  const by = new Map(items.map((i) => [i.id, i]));
  const one = (id: string) => {
    const x = by.get(id);
    assert(x, `回了 ${id}`);
    return x;
  };
  assertEquals([...by.keys()].sort(), [I1, I2, IP, ID, IV].sort(), '只回 E 自己的');
  const i1 = one(I1);
  assertEquals([i1.note_private, i1.note_gone, i1.bucket, i1.has_thumb, i1.tries], [false, false, 'images', false, 0]);
  assertEquals(one(IP).note_private, true, '隐私记的随手记');
  assertEquals(one(ID).note_gone, true, '随手记在最近删除');
  assertEquals(one(IV).bucket, 'vault-images');
} });

Deno.test({ name: '② 推后以后不再到期（tries + 1）；parkAll 推到同一时刻', ...opts, async fn() {
  const now = Date.now();
  await ai(E, (tx) => laterItems(tx, E, [IP, ID, IV], now + 3600_000, true));
  const left = await ai(E, (tx) => dueItems(tx, E, 20, now));
  assertEquals(left.map((i) => i.id).sort(), [I1, I2].sort());
  assertEquals((await img(IP)).ai_tries, 1);
  assertEquals((await ai(E, (tx) => dueItems(tx, E, 20, now + 3600_000))).length, 5, '到点以后又到期');
  await ai(F, (tx) => parkAll(tx, F, now + 7200_000));
  assertEquals((await img(IF)).ai_next_at, now + 7200_000);
  assertEquals((await ai(F, (tx) => dueItems(tx, F, 20, now))).length, 0);
  assert(!(await ai('', (tx) => dueUsers(tx, 1000, now))).includes(F), '推后的人不再被挑');
} });

Deno.test({ name: '③ skipConsent 只改普通图片；skipOther、failItem 只改 pending', ...opts, async fn() {
  const ids = await ai(E, (tx) => skipConsent(tx, E));
  assertEquals([...ids].sort(), [I1, I2, IP, ID].sort(), '普通图片 4 张（含隐私记随手记里、最近删除里的），vault-images 不动');
  assertEquals([(await img(I1)).ai_status, (await img(I1)).skip_reason], ['skip', 'consent']);
  assertEquals((await img(IV)).ai_status, 'pending', '隐私记的图不动');
  await sql`update public.note_images set skip_reason = 'other' where id = ${IP}`;
  await ai(E, (tx) => unskip(tx, E, ids));
  assertEquals([(await img(I1)).ai_status, (await img(I1)).skip_reason], ['pending', null], 'unskip 改回 pending');
  assertEquals((await img(IP)).skip_reason, 'other', '已经不是 skip / consent 的不动');
  await ai(E, (tx) => skipOther(tx, E, [I2]));
  assertEquals([(await img(I2)).ai_status, (await img(I2)).skip_reason], ['skip', 'other']);
  await ai(E, (tx) => failItem(tx, E, I2, 3));
  assertEquals((await img(I2)).ai_status, 'skip', '不是 pending 的不改成 failed');
  await ai(E, (tx) => failItem(tx, E, I1, 3));
  assertEquals([(await img(I1)).ai_status, (await img(I1)).ai_tries], ['failed', 3]);
} });

Deno.test({ name: '④ doneItem 写回描述和标签、入向量队列；不是 pending 的不写', ...opts, async fn() {
  await sql`update public.note_images set ai_status = 'pending' where id = ${I1}`;
  await sql`delete from private.embed_queue where source_id = ${I1}`;
  assertEquals(await ai(E, (tx) => doneItem(tx, E, I1, '一张收据', ['收据', '영수증'])), true);
  const r = await img(I1);
  assertEquals([r.ai_status, r.ai_desc, r.ai_tags, r.skip_reason], ['done', '一张收据', ['收据', '영수증'], null]);
  const q = await sql`select 1 from private.embed_queue where kind = 'image' and source_id = ${I1}`;
  assertEquals(q.length, 1, 'note_images_embed 触发器入队');
  assertEquals(await ai(E, (tx) => doneItem(tx, E, I2, '覆盖', [])), false, 'skip 的不写');
  assertEquals(await ai(E, (tx) => doneItem(tx, E, IV, '隐私', [])), false, 'vault-images 的不写');
  assertEquals((await img(IV)).ai_desc, null);
} });

Deno.test({ name: '⑤ file-check retryAi：failed 改回 pending，别的原样回，别人的回 null', ...opts, async fn() {
  await sql`update public.note_images set ai_status = 'failed', ai_tries = 3 where id = ${I2}`;
  assertEquals(await ai(E, (tx) => retryAi(tx, E, I2)), 'pending');
  const r = await img(I2);
  assertEquals([r.ai_status, r.ai_tries, r.skip_reason], ['pending', 0, null]);
  assertEquals(await ai(E, (tx) => retryAi(tx, E, I1)), 'done', 'done 的原样回');
  assertEquals(await ai(F, (tx) => retryAi(tx, F, I1)), null, '别人的图');
  assertEquals(await ai(E, (tx) => retryAi(tx, E, IV)), null, 'vault-images 的不认');
} });

Deno.test({ name: '⑥ 心跳写得进', ...opts, async fn() {
  const d = { users: 1, images: 2, done: 1, retry: 0, failed: 0, consent: 0, parked: 0, other: 0, calls: 1, ms: 10, quota_hit: false, global_yield: false, budget_hit: false };
  await ai('', (tx) => writeHeartbeat(tx, d));
  const hb = await sql<{ detail: Record<string, unknown> }[]>`select detail from private.heartbeat where name = 'ai-media'`;
  const sorted = (o: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)));
  assertEquals(sorted(hb[0]?.detail), sorted(d), 'jsonb 不保留键的顺序，排好再比');
} });

Deno.test({ name: '识图 store-it 收尾：删掉本次建的用户和心跳行', ...opts, async fn() {
  try {
    await sql`delete from private.heartbeat where name = 'ai-media'`;
    await purgeTraces(ours);
    await writeLedger([]);
  } finally {
    await closeVaultHarness();
    await releaseLock();
    await sql.end({ timeout: 5 });
    await s3Server.shutdown();
  }
} });
