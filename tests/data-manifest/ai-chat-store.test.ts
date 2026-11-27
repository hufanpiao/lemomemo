// ai-chat/store.ts 的四句真 SQL 以 fn_ai 身份跑（R-492；迁移 20261122090000）：PGlite 跑完全部迁移（同 grant-matrix.test.ts），
// 经 store.ts 自己的 runQuery（Tx 换成 PGlite：unsafe 带参数走 query、不带走 exec），SQL 和参数都是 store.ts 导出的那一份，不手抄。
// 覆盖：语句超时那句 fn_ai 能执行；日程按范围、按关键词（地点也算）；待办只要过期没做完的；随手记关键词命中的普通随手记出、
// 隐私记和 B 的不出、没设 app.uid 一行都没有；纪念日本人没删没撤销没归档的出（next_date 为空的公历按月日补上），B 的不出。
// 第 2 段：随手记带图的张数和已识别的描述、图的描述里有关键词也算查到；看图那句（NOTE_IMAGES_SQL）只出普通随手记 images 桶里没删的图，
// 隐私记的图（不管在哪个桶）、B 的图都连不上。
// 11-23 跨天日程：前几天开始、跨进查询起始日的日程也出（按 date + time + duration_min 算重叠；迁移 20261123100000）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { noteImages, runQuery, STMT_TIMEOUT, type QueryTx } from '../../supabase/functions/ai-chat/store.ts';
import { parseCall, type ToolQuery } from '../../supabase/functions/ai-chat/tools.ts';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const TODAY = '2026-11-22';
const id = (s: string) => `70000000-0000-4000-8000-0000000000${s}`;

const SEED = `
insert into auth.users (id, email) values ('${A}', 'a@test.local'), ('${B}', 'b@test.local');
insert into public.profiles (user_id) values ('${A}'), ('${B}');
insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, next_date, note, deleted_at, archived_at, created_at, updated_at) values
  ('${id('a1')}', '${A}', 'birthday', '妈妈生日', 'solar', 12, 1, '2026-12-01', '买蛋糕', null, null, 1, 1),
  ('${id('a2')}', '${A}', 'anniversary', '没算好的', 'solar', 11, 30, null, '', null, null, 1, 1),
  ('${id('a3')}', '${A}', 'countdown', '删了的', 'solar', 12, 2, '2026-12-02', '', 5, null, 1, 1),
  ('${id('a4')}', '${A}', 'countdown', '归档的', 'solar', 12, 3, '2026-12-03', '', null, 7, 1, 1),
  ('${id('b1')}', '${B}', 'birthday', 'B 的生日', 'solar', 12, 1, '2026-12-01', '', null, null, 1, 1);
insert into public.notes (id, user_id, title, body, created_at, updated_at) values
  ('${id('a5')}', '${A}', '拉面店', '弘大那家一兰拉面不错', 1763600000000, 1),
  ('${id('b5')}', '${B}', 'B 的拉面', '', 1763600000000, 1);
insert into public.notes (id, user_id, is_private, body_enc, enc_key_id, created_at, updated_at) values
  ('${id('a6')}', '${A}', true, '\\x01'::bytea, 1, 1, 1);
insert into public.notes (id, user_id, title, body, created_at, updated_at) values
  ('${id('c1')}', '${A}', '相册', '', 1763500000000, 1);
insert into public.note_images (id, user_id, note_id, bucket, path, bytes, has_thumb, ai_status, ai_desc, ai_tags, deleted_at) values
  ('${id('d1')}', '${A}', '${id('a5')}', 'images', '${A}/${id('a5')}/${id('d1')}.webp', 10, true, 'done', '一兰拉面的菜单', '{拉面}', null),
  ('${id('d2')}', '${A}', '${id('a5')}', 'images', '${A}/${id('a5')}/${id('d2')}.webp', 10, false, 'pending', null, '{}', null),
  ('${id('d3')}', '${A}', '${id('a5')}', 'images', '${A}/${id('a5')}/${id('d3')}.webp', 10, true, 'done', '删了的图', '{}', 9),
  ('${id('d4')}', '${A}', '${id('c1')}', 'images', '${A}/${id('c1')}/${id('d4')}.webp', 10, true, 'done', '一张超市收据', '{receipt}', null),
  ('${id('d5')}', '${A}', '${id('a6')}', 'vault-images', '${A}/${id('a6')}/${id('d5')}.webp', 10, true, 'pending', null, '{}', null),
  ('${id('d6')}', '${A}', '${id('a6')}', 'images', '${A}/${id('a6')}/${id('d6')}.webp', 10, true, 'done', '隐私记里的收据', '{}', null),
  ('${id('d7')}', '${B}', '${id('b5')}', 'images', '${B}/${id('b5')}/${id('d7')}.webp', 10, true, 'done', 'B 的收据', '{}', null);
insert into public.events (id, user_id, title, date, time, tz, location, note, created_at, updated_at) values
  ('${id('a7')}', '${A}', '设计评审会', '2026-11-25', '14:00', 'Asia/Seoul', '三楼', '', 1, 1),
  ('${id('b7')}', '${B}', 'B 的会', '2026-11-25', '14:00', 'Asia/Seoul', '三楼', '', 1, 1);
insert into public.events (id, user_id, title, date, time, tz, duration_min, location, note, created_at, updated_at) values
  ('${id('e1')}', '${A}', '跨夜航班', '2026-11-22', '22:00', 'Asia/Seoul', 300, '', '', 1, 1),
  ('${id('e2')}', '${A}', '到零点结束', '2026-11-22', '22:00', 'Asia/Seoul', 120, '', '', 1, 1),
  ('${id('e3')}', '${A}', '济州三天', '2026-11-21', null, null, 4320, '', '', 1, 1),
  ('${id('e4')}', '${A}', '前天全天', '2026-11-21', null, null, 1440, '', '', 1, 1),
  ('${id('e5')}', '${A}', '一个月前', '2026-10-01', null, null, 1440, '', '', 1, 1);
insert into public.todos (id, user_id, title, due, due_time, done, note, created_at, updated_at) values
  ('${id('a8')}', '${A}', '回复房东', '2026-11-20', null, false, '', 1, 1),
  ('${id('a9')}', '${A}', '交周报', '2026-11-21', '18:00', true, '', 1, 1);
`;

let pg: PGlite;
beforeAll(async () => {
  const { migratedPglite } = await import('./pglite-migrated.ts');
  pg = await migratedPglite();
  await pg.exec(SEED);
}, 120_000);
afterAll(async () => {
  await pg?.close();
});

/** 以 fn_ai 在一个事务里跑 runQuery（uid 为 null 时不设 app.uid） */
async function asFnAi(uid: string | null, q: ToolQuery): Promise<{ ids: string[]; rows: Awaited<ReturnType<typeof runQuery>> }> {
  await pg.exec('begin; set local role fn_ai;');
  try {
    if (uid !== null) await pg.query(`select set_config('app.uid', $1, true)`, [uid]);
    const tx = {
      unsafe: async (sql: string, params?: unknown[]) => (params ? (await pg.query(sql, params)).rows : (await pg.exec(sql), [])),
    } as unknown as QueryTx;
    const rows = await runQuery(tx, uid ?? A, q, 'Asia/Seoul');
    return { ids: rows.map((r) => r.id), rows };
  } finally {
    await pg.exec('rollback');
  }
}

const call = (name: string, args: Record<string, unknown>): ToolQuery => {
  const q = parseCall(name, args, TODAY);
  if ('error' in q) throw new Error(q.error);
  if (q.tool === 'web_search' || q.tool === 'look_note_images' || q.tool === 'remember' || q.tool === 'draft_records') throw new Error('not_a_query');
  return q;
};

describe('ai-chat store：四句真 SQL 以 fn_ai 跑', () => {
  it('语句超时那句 fn_ai 能执行（3 秒）', async () => {
    expect(STMT_TIMEOUT).toBe("set local statement_timeout = '3000ms'");
    await pg.exec('begin; set local role fn_ai;');
    await pg.exec(STMT_TIMEOUT);
    const r = await pg.query<{ t: string }>(`select current_setting('statement_timeout') as t`);
    await pg.exec('rollback');
    expect(r.rows[0]?.t).toBe('3s');
  }, 30_000);

  it('日程：按日子范围读到本人的，B 的不出；关键词命中地点也算，没命中的不出', async () => {
    // 从 11-24 起查（11-23 有两条跨天的，见下一条用例）
    const all = await asFnAi(A, call('find_events', { from: '2026-11-24', to: '2026-11-29' }));
    expect(all.rows).toEqual([{ kind: 'event', id: id('a7'), title: '设计评审会', date: '2026-11-25', time: '14:00', where: '三楼', body: '' }]);
    expect((await asFnAi(A, call('find_events', { from: '2026-11-23', to: '2026-11-29', q: '三楼' }))).ids).toEqual([id('a7')]);
    expect((await asFnAi(A, call('find_events', { from: '2026-11-23', to: '2026-11-29', q: '拉面' }))).ids).toEqual([]);
  }, 30_000);

  it('跨天日程（负责人 11-23）：前一天开始、跨进起始日的也查出来；正好零点结束的、前天全天一天的、早就结束的不出', async () => {
    // 11-22 22:00 起 5 小时（到 11-23 03:00）跨进 11-23；11-21 全天三天（21、22、23）跨进 11-23
    expect((await asFnAi(A, call('find_events', { from: '2026-11-23', to: '2026-11-23' }))).ids).toEqual([id('e3'), id('e1')]);
    // 起始日当天开始的照旧出；查 11-22 一天：两场 22:00 的、全天三天的都在
    expect((await asFnAi(A, call('find_events', { from: '2026-11-22', to: '2026-11-22' }))).ids).toEqual([id('e3'), id('e1'), id('e2')]);
    // 跨天的过了结束日就不出
    expect((await asFnAi(A, call('find_events', { from: '2026-11-24', to: '2026-11-24' }))).ids).toEqual([]);
  }, 30_000);

  it('待办：overdue 只要过期没做完的；done 只要做完的', async () => {
    expect((await asFnAi(A, call('find_todos', { status: 'overdue' }))).ids).toEqual([id('a8')]);
    expect((await asFnAi(A, call('find_todos', { status: 'done' }))).ids).toEqual([id('a9')]);
  }, 30_000);

  it('随手记：关键词命中的普通随手记出（写下那天按时区算），隐私记、B 的不出；没设 app.uid 一行都没有', async () => {
    const r = await asFnAi(A, call('search_notes', { q: '拉面' }));
    expect(r.rows).toEqual([{
      kind: 'note', id: id('a5'), title: '拉面店', date: '2025-11-20', time: null, body: '弘大那家一兰拉面不错', images: 2, descs: ['一兰拉面的菜单'],
    }]);
    expect((await asFnAi(null, call('search_notes', { q: '拉面' }))).ids).toEqual([]);
    // 就算 where 里的 user_id 写成 B，A 的事务里也读不到 B 的（视图只含 app.uid 本人的行）
    await pg.exec('begin; set local role fn_ai;');
    await pg.query(`select set_config('app.uid', $1, true)`, [A]);
    const cross = await pg.query(`select id from private.ai_chat_notes where user_id = $1::uuid`, [B]);
    const priv = await pg.query(`select id from private.ai_chat_notes where id = $1::uuid`, [id('a6')]);
    await pg.exec('rollback');
    expect(cross.rows).toEqual([]);
    expect(priv.rows).toEqual([]);
  }, 30_000);

  it('纪念日：本人没删、没撤销、没归档的出，next_date 为空的公历按月日补上；B 的不出', async () => {
    const r = await asFnAi(A, call('list_anniversaries', {}));
    expect(r.rows.map((x) => [x.id, x.date])).toEqual([
      [id('a2'), '2026-11-30'],
      [id('a1'), '2026-12-01'],
    ]);
    expect((await asFnAi(null, call('list_anniversaries', {}))).ids).toEqual([]);
  }, 30_000);

  it('第 2 段：图的描述、标签里有关键词的随手记也查到；隐私记里的图、B 的图不算', async () => {
    const r = await asFnAi(A, call('search_notes', { q: '收据' }));
    expect(r.rows).toEqual([{ kind: 'note', id: id('c1'), title: '相册', date: '2025-11-19', time: null, body: '', images: 1, descs: ['一张超市收据'] }]);
    expect((await asFnAi(A, call('search_notes', { q: 'receipt' }))).ids).toEqual([id('c1')]);
  }, 30_000);

  it('第 2 段看图：只出普通随手记 images 桶里没删、有缩略图的图（按插入先后；没缩略图的不出，不读原图）；隐私记的图、B 的图连不上；没设 app.uid 没有', async () => {
    const run = async (uid: string | null, noteId: string, limit = 3) => {
      await pg.exec('begin; set local role fn_ai;');
      try {
        if (uid !== null) await pg.query(`select set_config('app.uid', $1, true)`, [uid]);
        const tx = { unsafe: async (sql: string, params?: unknown[]) => (params ? (await pg.query(sql, params)).rows : (await pg.exec(sql), [])) } as unknown as QueryTx;
        return await noteImages(tx, uid ?? A, noteId, limit);
      } finally {
        await pg.exec('rollback');
      }
    };
    expect(await run(A, id('a5'))).toEqual([{ id: id('d1'), noteId: id('a5') }]);
    expect((await run(A, id('a5'), 0)).length).toBe(0);
    expect(await run(A, id('a6'))).toEqual([]);
    expect(await run(A, id('b5'))).toEqual([]);
    expect(await run(null, id('a5'))).toEqual([]);
  }, 30_000);
});
