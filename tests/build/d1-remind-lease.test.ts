// D1 第 6 节之二：往 remind_queue 插入的 private 函数冲突时一律清租约（build/d1/remind-lease.ts；REMIND-queue-crash-loss，迁移 20261104130000）。
// 真库上的反例是 supabase/tests/d1-fixtures/38（离线 PGlite 跑）；这里只测判定逻辑，并核对迁移里 4 个入口的最新写法都过得了。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { leaseResetProblems } from '../../build/d1/remind-lease.ts';

const RESET = 'on conflict (table_name, id) do update set claim = null, claimed_at = null, attempts = 0 where q.claim is not null or q.attempts > 0';

describe('leaseResetProblems', () => {
  it('每处插入都配了清租约：不报；不碰 remind_queue 的函数不看', () => {
    expect(leaseResetProblems([
      { f: 'a', src: `insert into private.remind_queue as q (table_name, id) values ('todos', x) ${RESET};` },
      { f: 'b', src: `insert into private.remind_queue as q (table_name, id) select 1 ${RESET}; INSERT  INTO private.remind_queue as q select 2\n ON CONFLICT ( table_name , id ) DO UPDATE SET claim = null , claimed_at = null , attempts = 0;` },
      { f: 'c', src: 'insert into private.embed_queue values (1) on conflict do nothing;' },
    ])).toEqual([]);
  });

  it('on conflict do nothing、只清 claim 没清 claimed_at、清了租约没清 attempts（L2）、三处里只有两处清：各报一条，写出几处', () => {
    expect(leaseResetProblems([
      { f: 'x', src: 'insert into private.remind_queue (table_name, id) values (1, 2) on conflict do nothing;' },
      { f: 'y', src: 'insert into private.remind_queue as q values (1) on conflict (table_name, id) do update set claim = null;' },
      { f: 'w', src: 'insert into private.remind_queue as q values (1) on conflict (table_name, id) do update set claim = null, claimed_at = null where q.claim is not null;' },
      { f: 'z', src: `insert into private.remind_queue as q select 1 ${RESET}; insert into private.remind_queue as q select 2 ${RESET}; insert into private.remind_queue select 3 on conflict do nothing;` },
    ])).toEqual([
      'private.x 往 remind_queue 插入 1 处，只有 0 处冲突时清租约（要写 on conflict (table_name, id) do update set claim = null, claimed_at = null, attempts = 0；迁移 20261104130000）',
      'private.y 往 remind_queue 插入 1 处，只有 0 处冲突时清租约（要写 on conflict (table_name, id) do update set claim = null, claimed_at = null, attempts = 0；迁移 20261104130000）',
      'private.w 往 remind_queue 插入 1 处，只有 0 处冲突时清租约（要写 on conflict (table_name, id) do update set claim = null, claimed_at = null, attempts = 0；迁移 20261104130000）',
      'private.z 往 remind_queue 插入 3 处，只有 2 处冲突时清租约（要写 on conflict (table_name, id) do update set claim = null, claimed_at = null, attempts = 0；迁移 20261104130000）',
    ]);
  });

  it('迁移 20261104130000 重建的 4 个入口（enqueue_remind、enqueue_anniv_defaults、enqueue_allday_defaults、enqueue_floating 共 6 处插入）都过得了', () => {
    const sql = readFileSync('supabase/migrations/20261104130000_core_remind_queue_lease.sql', 'utf8');
    const fns = [...sql.matchAll(/^create or replace function private\.([a-z_]+)\([^)]*\)[\s\S]*?\$\$([\s\S]*?)\$\$;$/gm)].map((m) => ({ f: m[1] ?? '', src: m[2] ?? '' }));
    expect(fns.map((x) => x.f)).toEqual(['enqueue_remind', 'enqueue_anniv_defaults', 'enqueue_allday_defaults', 'enqueue_floating']);
    expect(fns.reduce((n, x) => n + (x.src.match(/insert into private\.remind_queue/g) ?? []).length, 0)).toBe(6);
    expect(leaseResetProblems(fns)).toEqual([]);
  });
});
