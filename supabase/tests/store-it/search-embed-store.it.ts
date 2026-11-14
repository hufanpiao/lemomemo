// B4b-2 智能查找 store-it：ai-embed/store.ts、note-search/store.ts 的 SQL 第一次上真库（以 fn_ai 跑，切角色办法见 vault-harness.ts 的 asRole）。入口 run.mjs。
// 覆盖（11-14 整块评审第 1、4 条）：
//   ① 入队触发器写的队列行：dueUsers（跨用户扫描视图）挑得到 E、F，dueItems 只回本人的随手记、待办；sources 读得到正文；
//   ② writeVector 写入、hashes 读回、settleItems 删队列行；nearest 用 operator(extensions.<=>) 算出相似度，只回本人、is_vault 的不回；
//   ③ 读完以后源头又改了（入队触发器更新 queued_at）：拿旧 queued_at 的 writeVector 不写；
//   ④ 并发：另一个事务改了源头还没提交（握着队列行的锁），writeVector 等它提交再判，判出 queued_at 变了就不写（移进隐私记同一条路径）；
//   ⑤ laterItems 推后以后 dueItems 不再回；writeHeartbeat 过 heartbeat 的策略。
import { dueItems, dueUsers, hashes, laterItems, settleItems, sources, writeHeartbeat, writeVector } from '../../functions/ai-embed/store.ts';
import { nearest } from '../../functions/note-search/store.ts';
import { assert, assertEquals, healLeftovers, mkUser, ours, purgeTraces, releaseLock, s3Server, sleep, sql, writeLedger } from './harness.ts';
import { asRole, closeVaultHarness } from './vault-harness.ts';

const opts = { sanitizeOps: false, sanitizeResources: false };
const MODEL = 'gemini-embedding-2';
const V = Array.from({ length: 768 }, (_, i) => (i % 7) / 10);
let E = '', F = '';
const N1 = crypto.randomUUID(), T1 = crypto.randomUUID(), NF = crypto.randomUUID();
const ai = <T>(uid: string, fn: Parameters<typeof asRole<T>>[2]) => asRole<T>('fn_ai', uid, fn);

Deno.test({ name: '查找 store-it 开跑：清上次残留、建 E、F，各写几条（入队触发器入队）', ...opts, async fn() {
  await healLeftovers();
  E = await mkUser('search-e');
  F = await mkUser('search-f');
  await sql`insert into public.notes (id, user_id, title, body, created_at, updated_at) values (${N1}, ${E}, '牙医', '下周二复诊', 1, 1)`;
  await sql`insert into public.todos (id, user_id, title, created_at, updated_at) values (${T1}, ${E}, '预约洗牙', 1, 1)`;
  await sql`insert into public.notes (id, user_id, title, body, created_at, updated_at) values (${NF}, ${F}, '牙医', 'F 的', 1, 1)`;
} });

Deno.test({ name: '① 跨用户扫描挑人、按人取队列、读源头', ...opts, async fn() {
  const users = await ai('', (tx) => dueUsers(tx, 1000));
  assert(users.includes(E) && users.includes(F), `扫描视图挑得到 E、F：${users.length} 人`);
  const items = await ai(E, (tx) => dueItems(tx, E, 20));
  assertEquals(items.map((i) => `${i.kind}:${i.source_id}`).sort(), [`note:${N1}`, `todo:${T1}`].sort(), '只回 E 自己的');
  const src = await ai(E, (tx) => sources(tx, E, items));
  assertEquals(src.get(`note:${N1}`), { state: 'ok', title: '牙医', text: '下周二复诊' });
  assertEquals(src.get(`todo:${T1}`), { state: 'ok', title: '预约洗牙', text: '' });
} });

Deno.test({ name: '② 写向量、读 hash、删队列；按意思找只回本人、不回 is_vault', ...opts, async fn() {
  const items = await ai(E, (tx) => dueItems(tx, E, 20));
  for (const it of items) assert(await ai(E, (tx) => writeVector(tx, E, it, MODEL, `h-${it.kind}`, V)), `写入 ${it.kind}`);
  const h = await ai(E, (tx) => hashes(tx, E, items, MODEL));
  assertEquals([h.get(`note:${N1}`), h.get(`todo:${T1}`)], ['h-note', 'h-todo']);
  await ai(E, (tx) => settleItems(tx, E, items));
  assertEquals((await ai(E, (tx) => dueItems(tx, E, 20))).length, 0, '队列删干净');
  const fItems = await ai(F, (tx) => dueItems(tx, F, 20));
  for (const it of fItems) await ai(F, (tx) => writeVector(tx, F, it, MODEL, 'h', V));
  const hits = await ai(E, (tx) => nearest(tx, E, V, MODEL, 30, 0.55));
  assertEquals(hits.map((x) => `${x.kind}:${x.id}`).sort(), [`note:${N1}`, `todo:${T1}`].sort(), '只回 E 的');
  assert(hits.every((x) => x.score > 0.99), `同一个向量相似度约 1：${JSON.stringify(hits)}`);
  await sql`update private.note_vectors set is_vault = true where source_id = ${T1}`;
  assertEquals((await ai(E, (tx) => nearest(tx, E, V, MODEL, 30, 0.55))).map((x) => x.id), [N1], 'is_vault 的不回');
  assertEquals((await ai(E, (tx) => nearest(tx, E, V, 'other-model', 30, 0.55))).length, 0, '别的模型不回');
} });

Deno.test({ name: '③ 读完以后源头又改了：拿旧 queued_at 写不进', ...opts, async fn() {
  await sql`update public.notes set body = '改成周三' where id = ${N1}`;
  const [old] = await ai(E, (tx) => dueItems(tx, E, 20));
  assert(old, '改了以后重新入队');
  await sleep(20);
  await sql`update public.notes set body = '又改成周四' where id = ${N1}`;
  assertEquals(await ai(E, (tx) => writeVector(tx, E, old, MODEL, 'stale', V)), false, '旧 queued_at 不写');
  assertEquals((await ai(E, (tx) => hashes(tx, E, [old], MODEL))).get(`note:${N1}`), 'h-note', '向量还是上一次的');
} });

Deno.test({ name: '④ 并发：别的事务改了源头还没提交，writeVector 等它提交再判，不写旧内容', ...opts, async fn() {
  const [old] = await ai(E, (tx) => dueItems(tx, E, 20));
  assert(old, '队列里有这条');
  let release = (): void => {};
  const gate = new Promise<void>((ok) => { release = ok; });
  const other = sql.begin(async (tx) => {
    await tx`update public.notes set title = '牙医（隐私）' where id = ${N1}`;   // 入队触发器在这个事务里更新 queued_at、锁住队列行
    await gate;
  });
  await sleep(300);
  let done = false;
  const w = ai(E, (tx) => writeVector(tx, E, old, MODEL, 'race', V)).then((r) => { done = true; return r; });
  await sleep(500);
  assertEquals(done, false, '另一个事务没提交时 writeVector 在等');
  release();
  await other;
  assertEquals(await w, false, '对方提交以后 queued_at 变了，不写');
  assertEquals((await ai(E, (tx) => hashes(tx, E, [old], MODEL))).get(`note:${N1}`), 'h-note');
} });

Deno.test({ name: '⑤ 推后以后不再到期；心跳写得进', ...opts, async fn() {
  const items = await ai(E, (tx) => dueItems(tx, E, 20));
  assert(items.length > 0, '还有到期的');
  await ai(E, (tx) => laterItems(tx, E, items, Date.now() + 3600_000, true));
  assertEquals((await ai(E, (tx) => dueItems(tx, E, 20))).length, 0);
  const tries = await sql<{ tries: number }[]>`select tries from private.embed_queue where user_id = ${E}`;
  assert(tries.every((r) => r.tries === 1), `tries + 1：${JSON.stringify(tries)}`);
  await ai('', (tx) => writeHeartbeat(tx, { users: 1, embedded: 2 }));
  const hb = await sql<{ detail: Record<string, number> }[]>`select detail from private.heartbeat where name = 'ai-embed'`;
  assertEquals(hb[0]?.detail, { users: 1, embedded: 2 });
} });

Deno.test({ name: '查找 store-it 收尾：删掉本次建的用户和心跳行', ...opts, async fn() {
  try {
    await sql`delete from private.heartbeat where name = 'ai-embed'`;
    await purgeTraces(ours);
    await writeLedger([]);
  } finally {
    await closeVaultHarness();
    await releaseLock();
    await sql.end({ timeout: 5 });
    await s3Server.shutdown();
  }
} });
