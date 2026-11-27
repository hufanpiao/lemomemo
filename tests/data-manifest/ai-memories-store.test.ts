// _shared/memories.ts 的真 SQL 以 fn_ai 跑（R-495；迁移 20261123130000）：PGlite 跑完全部迁移，经导出的函数读写。
// 覆盖：存、判重、改写、条数上限、按问题召回（中韩）、分页、合计字数、通配符、删和撤销、撤销撞重复、全部清空真删、两个人互相隔离、没设 app.uid 什么都读不到。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { clearMemories, deleteMemory, listMemories, MEMORIES_MAX, MEMORY_PAGE, normMemory, PROMPT_MAX, promptMemories, RECENT_SHOWN, recentMemories, relatedMemories, saveMemories as saveAt, undoMemory, undoReplace, type MemoryTx, type MemoryWrite } from '../../supabase/functions/_shared/memories.ts';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const w = (text: string, replaces: string | null = null): MemoryWrite => ({ text, norm: normMemory(text), replaces });

let pg: PGlite;
beforeAll(async () => {
  const { migratedPglite } = await import('./pglite-migrated.ts');
  pg = await migratedPglite();
  await pg.exec(`insert into auth.users (id, email) values ('${A}', 'a@test.local'), ('${B}', 'b@test.local');`);
}, 120_000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await pg.exec('delete from private.ai_memories');
});

async function as<T>(uid: string | null, fn: (tx: MemoryTx) => Promise<T>): Promise<T> {
  await pg.exec('begin; set local role fn_ai;');
  try {
    if (uid !== null) await pg.query(`select set_config('app.uid', $1, true)`, [uid]);
    const tx = { unsafe: async (sql: string, params?: unknown[]) => (params ? (await pg.query(sql, params)).rows : (await pg.exec(sql), [])) } as unknown as MemoryTx;
    const out = await fn(tx);
    await pg.exec('commit');
    return out;
  } catch (e) {
    await pg.exec('rollback');
    throw e;
  }
}
const list = async (uid: string) => (await as(uid, (tx) => listMemories(tx, uid))).items;
const total = async (uid: string) => (await as(uid, (tx) => listMemories(tx, uid))).total;
/** 造 n 条比 at 新的填充记忆（英文短串，不和中韩问题撞词条） */
const fill = (uid: string, n: number, at = 1000) => pg.exec(`insert into private.ai_memories (user_id, text, norm, created_at, updated_at)
  select '${uid}', 'f' || i, 'f' || i, ${at} + i, ${at} + i from generate_series(1, ${n}) i`);
const promptMemoriesFor = async (tx: MemoryTx, uid: string, q: string) => {
  const r = await recentMemories(tx, uid);
  return { shown: promptMemories(r.rows, await relatedMemories(tx, uid, q)) };
};
const ask = (uid: string, q: string) => as(uid, (tx) => promptMemoriesFor(tx, uid, q));
const verOf = (uid: string) => as(uid, async (tx) => (await recentMemories(tx, uid)).ver);
/** 这一轮开始时读的版本就是当前版本（没有并发）时的保存 */
const saveMemories = async (tx: MemoryTx, uid: string, items: readonly MemoryWrite[], now: number) => saveAt(tx, uid, items, now, (await recentMemories(tx, uid)).ver);

describe('长期记忆：真 SQL', () => {
  it('存上、同样的话（标点空格不同）不再存', async () => {
    const one = await as(A, (tx) => saveMemories(tx, A, [w('对花生过敏')], 10));
    expect(one).toHaveLength(1);
    expect(await as(A, (tx) => saveMemories(tx, A, [w('对 花生，过敏')], 20))).toEqual([]);
    expect((await list(A)).map((m) => m.text)).toEqual(['对花生过敏']);
  });
  it('改写：旧行软删、另插新行，回包带旧行；条数不变，日期是改写的时刻', async () => {
    const [m] = await as(A, (tx) => saveMemories(tx, A, [w('我不吃香菜')], 10));
    const out = await as(A, (tx) => saveMemories(tx, A, [w('我吃香菜', m?.id ?? null)], 20));
    expect(out[0]?.id).not.toBe(m?.id);
    expect(out[0]?.replaced).toEqual({ id: m?.id, text: '我不吃香菜' });
    const now = await list(A);
    expect(now.map((x) => x.text)).toEqual(['我吃香菜']);
    expect(now[0]?.at).toBe(20);
    expect(await total(A)).toBe(1);
  });
  it('撤销改写：换回旧文字和原来的日期；新行不留', async () => {
    const [m] = await as(A, (tx) => saveMemories(tx, A, [w('我不吃香菜')], 10));
    const [n] = await as(A, (tx) => saveMemories(tx, A, [w('我吃香菜', m?.id ?? null)], 20));
    expect(await as(A, (tx) => undoReplace(tx, A, n?.id ?? '', m?.id ?? '', 30))).toBe(true);
    const now = await list(A);
    expect(now.map((x) => [x.text, x.at])).toEqual([['我不吃香菜', 10]]);
    expect(await as(A, (tx) => undoReplace(tx, A, n?.id ?? '', m?.id ?? '', 40))).toBe(false);
  });
  it('撤销改写：旧文字又被记过就不换，新行不动；别人的换不了', async () => {
    const [m] = await as(A, (tx) => saveMemories(tx, A, [w('周报周五交')], 10));
    const [n] = await as(A, (tx) => saveMemories(tx, A, [w('周报周四交', m?.id ?? null)], 20));
    await as(A, (tx) => saveMemories(tx, A, [w('周报周五交')], 30));
    expect(await as(A, (tx) => undoReplace(tx, A, n?.id ?? '', m?.id ?? '', 40))).toBe(false);
    expect((await list(A)).map((x) => x.text).sort()).toEqual(['周报周五交', '周报周四交'].sort());
    expect(await as(B, (tx) => undoReplace(tx, B, n?.id ?? '', m?.id ?? '', 40))).toBe(false);
    expect(await total(A)).toBe(2);
  });
  it('replaces 没命中（旧行刚被删）：直接丢弃，不当新记忆插入', async () => {
    const [m] = await as(A, (tx) => saveMemories(tx, A, [w('周报周五交')], 10));
    await as(A, (tx) => deleteMemory(tx, A, m?.id ?? '', 20));
    expect(await as(A, (tx) => saveMemories(tx, A, [w('周报周四交', m?.id ?? null)], 30))).toEqual([]);
    expect(await list(A)).toEqual([]);
  });
  it.each([
    ['删了一条', (id: string) => as(A, (tx) => deleteMemory(tx, A, id, 20))],
    ['全部清空', () => as(A, (tx) => clearMemories(tx, A))],
    ['另一轮存了一条', () => as(A, (tx) => saveMemories(tx, A, [w('别的事')], 20))],
  ])('在途一轮：开轮后%s，保存整批放弃', async (_k, change) => {
    const [m] = await as(A, (tx) => saveMemories(tx, A, [w('喜欢拉面')], 10));
    const ver = await verOf(A);
    await change(m?.id ?? '');
    expect(await as(A, (tx) => saveAt(tx, A, [w('喜欢寿司')], 30, ver))).toEqual([]);
    expect((await list(A)).map((x) => x.text)).not.toContain('喜欢寿司');
  });
  it('判重键：3.5 和 35、C++ 和 C# 不算重复；唯一索引认同一份', async () => {
    expect(await as(A, (tx) => saveMemories(tx, A, [w('每天吃 3.5 毫克'), w('每天吃 35 毫克')], 10))).toHaveLength(2);
    expect(await as(A, (tx) => saveMemories(tx, A, [w('我用 C++'), w('我用 C#')], 11))).toHaveLength(2);
    expect(await as(A, (tx) => saveMemories(tx, A, [w('每天吃 3.5 毫克。')], 12))).toEqual([]);
  });
  it(`满 ${MEMORIES_MAX} 条不再新增`, async () => {
    await fill(A, MEMORIES_MAX - 1);
    expect(await as(A, (tx) => saveMemories(tx, A, [w('正好第五千条')], 10))).toHaveLength(1);
    expect(await total(A)).toBe(MEMORIES_MAX);
    expect(await as(A, (tx) => saveMemories(tx, A, [w('再来一条')], 10))).toEqual([]);
    expect(await total(A)).toBe(MEMORIES_MAX);
    // 满了还能改写；删一条再记满，撤销那条不会超上限
    const [first] = await list(A);
    const edited = await as(A, (tx) => saveMemories(tx, A, [w('改写这一条', first?.id ?? null)], 20000));
    expect(edited).toHaveLength(1);
    expect(await total(A)).toBe(MEMORIES_MAX);
    expect(await as(A, (tx) => deleteMemory(tx, A, edited[0]?.id ?? '', 30000))).toBe(true);
    expect(await as(A, (tx) => saveMemories(tx, A, [w('补上这一条')], 30000))).toHaveLength(1);
    expect(await as(A, (tx) => undoMemory(tx, A, edited[0]?.id ?? ''))).toBe(false);
    expect(await total(A)).toBe(MEMORIES_MAX);
  }, 60_000);
  it('删了读不到，撤销回来；同样的话又记过就不恢复', async () => {
    const [m] = await as(A, (tx) => saveMemories(tx, A, [w('喜欢拉面')], 10));
    const id = m?.id ?? '';
    expect(await as(A, (tx) => deleteMemory(tx, A, id, 20))).toBe(true);
    expect(await list(A)).toEqual([]);
    expect(await as(A, (tx) => undoMemory(tx, A, id))).toBe(true);
    expect(await list(A)).toHaveLength(1);
    await as(A, (tx) => deleteMemory(tx, A, id, 30));
    await as(A, (tx) => saveMemories(tx, A, [w('喜欢拉面')], 40));
    expect(await as(A, (tx) => undoMemory(tx, A, id))).toBe(false);
    expect(await list(A)).toHaveLength(1);
  });
  it('全部清空：连软删的一起真删，只删自己的', async () => {
    const [m] = await as(A, (tx) => saveMemories(tx, A, [w('甲'), w('乙')], 10));
    await as(A, (tx) => deleteMemory(tx, A, m?.id ?? '', 20));
    await as(B, (tx) => saveMemories(tx, B, [w('B 的')], 10));
    await as(A, (tx) => clearMemories(tx, A));
    expect((await pg.query<{ n: number }>(`select count(*)::int as n from private.ai_memories where user_id = '${A}'`)).rows[0]?.n).toBe(0);
    expect(await list(B)).toHaveLength(1);
  });
  it('A 删不了、撤销不了 B 的；没设 app.uid 读不到', async () => {
    const [m] = await as(B, (tx) => saveMemories(tx, B, [w('B 的事')], 10));
    const id = m?.id ?? '';
    expect(await as(A, (tx) => deleteMemory(tx, A, id, 20))).toBe(false);
    expect(await as(A, (tx) => deleteMemory(tx, B, id, 20))).toBe(false);
    expect(await list(B)).toHaveLength(1);
    expect((await as(null, (tx) => listMemories(tx, B))).items).toEqual([]);
  });
});

describe('长期记忆：按问题找、分页', () => {
  it.each([
    ['中文', '对花生过敏，推荐吃的要避开', '我花生过敏能吃这个吗'],
    ['韩文', '땅콩 알레르기가 있어요', '땅콩 먹어도 돼요?'],
    ['英文', 'allergic to peanut', 'any peanut in this?'],
  ])('%s：不在最近几条里的旧记忆，被相关问题找回来', async (_k, old, q) => {
    await as(A, (tx) => saveMemories(tx, A, [w(old)], 10));
    await fill(A, 30);
    expect((await ask(A, '今天天气')).shown.map((m) => m.text)).not.toContain(old);
    const { shown } = await ask(A, q);
    expect(await total(A)).toBe(31);
    expect(shown).toHaveLength(RECENT_SHOWN + 1);
    expect(shown.at(-1)?.text).toBe(old);
  });
  it('改写后按新文字找得到、旧文字找不到', async () => {
    const [m] = await as(A, (tx) => saveMemories(tx, A, [w('周报周五交')], 10));
    await as(A, (tx) => saveMemories(tx, A, [w('喜欢吃拉面', m?.id ?? null)], 11));
    await fill(A, 30);
    expect((await ask(A, '拉面')).shown.map((x) => x.text)).toContain('喜欢吃拉面');
    expect((await ask(A, '周报')).shown.map((x) => x.text)).not.toContain('喜欢吃拉面');
  });
  it(`合计不超过 ${PROMPT_MAX} 字、不重复`, async () => {
    const many = Array.from({ length: 100 }, (_, i) => w(`花生${i}`.padEnd(200, '记')));
    await as(A, (tx) => saveMemories(tx, A, many, 10));
    const { shown } = await ask(A, '花生');
    expect(shown.reduce((n, r) => n + r.text.length, 0)).toBeLessThanOrEqual(PROMPT_MAX);
    expect(new Set(shown.map((r) => r.id)).size).toBe(shown.length);
    expect(shown.length).toBeGreaterThan(RECENT_SHOWN);
  });
  it('别人的记忆搜不到：查询和 RLS 两道', async () => {
    await as(B, (tx) => saveMemories(tx, B, [w('对花生过敏')], 10));
    expect((await ask(A, '花生过敏')).shown).toEqual([]);
    expect((await as(A, (tx) => promptMemoriesFor(tx, B, '花生过敏'))).shown).toEqual([]);
  });
  it.each(['%', '_', '%%%___', '\\%', "'); drop table private.ai_memories; --", '花%生'])('通配符、注入当普通文字：%s', async (q) => {
    await as(A, (tx) => saveMemories(tx, A, [w('对花生过敏')], 10));
    await fill(A, 30);
    const { shown } = await ask(A, q);
    expect(shown.map((m) => m.text)).not.toContain('对花生过敏');
    expect(shown).toHaveLength(RECENT_SHOWN);
    expect(await total(A)).toBe(31);
  });
  it('分页：一页一页读完，不重不漏，同一时刻的也不丢', async () => {
    await pg.exec(`insert into private.ai_memories (user_id, text, norm, created_at, updated_at) select '${A}', 'p' || i, 'p' || i, 5, 5 from generate_series(1, 120) i`);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const at: string | null = cursor;
      const p: Awaited<ReturnType<typeof listMemories>> = await as(A, (tx) => listMemories(tx, A, at));
      expect(p.items.length).toBeLessThanOrEqual(MEMORY_PAGE);
      expect(p.total).toBe(120);
      seen.push(...p.items.map((m) => m.id));
      cursor = p.next;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(120);
  });
});
