// D1 第 6 节之二：提醒队列的唯一入口（build/d1/remind-lease.ts；R-411 迁移 20261113100000）。
// 真库上的反例是 supabase/tests/d1-fixtures/38、48（离线 PGlite 跑）；这里只测判定逻辑，并核对迁移里唯一入口的写法过得了。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { leaseResetProblems } from '../../build/d1/remind-lease.ts';

const RESET = 'on conflict (table_name, id) do update set user_id = excluded.user_id, claim = null, claimed_at = null, attempts = 0, prio = least(q.prio, excluded.prio)';
const OK = { f: 'remind_enqueue', src: `insert into private.remind_queue as q (table_name, id, user_id) select 1 ${RESET};` };

describe('leaseResetProblems（唯一入口）', () => {
  it('只有 remind_enqueue 写、一句、冲突时换主人清租约：不报；不碰 remind_queue 的函数不看；大小写和空白不影响', () => {
    expect(leaseResetProblems([
      OK,
      { f: 'enqueue_floating', src: "perform private.remind_enqueue('floating', p_user, null, null, false, 0::smallint);" },
      { f: 'c', src: 'insert into private.embed_queue values (1) on conflict do nothing;' },
    ])).toEqual([]);
    expect(leaseResetProblems([{ f: 'remind_enqueue', src: 'INSERT  INTO private.remind_queue as q select 2\n ON CONFLICT ( table_name , id ) DO UPDATE SET user_id = EXCLUDED.user_id , claim = null , claimed_at = null , attempts = 0;' }])).toEqual([]);
  });

  it('别的函数写队列（哪怕也清租约）、唯一入口不在、写了两句、冲突时不清 attempts 或不换主人：各报一条', () => {
    expect(leaseResetProblems([OK, { f: 'x', src: `insert into private.remind_queue as q values (1) ${RESET};` }]))
      .toEqual(['private.x 直接往 remind_queue 插入（一律改调 private.remind_enqueue；R-411 迁移 20261113100000）']);
    expect(leaseResetProblems([])).toEqual(['private.remind_enqueue 不在（写提醒队列的唯一入口，R-411 迁移 20261113100000）']);
    expect(leaseResetProblems([{ f: 'remind_enqueue', src: `${OK.src} ${OK.src}` }]))
      .toEqual(['private.remind_enqueue 里往 remind_queue 插入 2 句（只准一句，各 scope 写在同一句的 select 里）']);
    const noReset = /冲突时不换主人、不清租约/;
    for (const src of [
      'insert into private.remind_queue as q values (1) on conflict do nothing;',
      'insert into private.remind_queue as q values (1) on conflict (table_name, id) do update set user_id = excluded.user_id, claim = null, claimed_at = null;',
      'insert into private.remind_queue as q values (1) on conflict (table_name, id) do update set claim = null, claimed_at = null, attempts = 0;',
    ]) {
      const p = leaseResetProblems([{ f: 'remind_enqueue', src }]);
      expect(p).toHaveLength(1);
      expect(p[0]).toMatch(noReset);
    }
  });

  it('迁移 20261113100000 的 remind_enqueue 过得了，且全迁移只有它一句 insert into private.remind_queue（其余入口都改成转发）', () => {
    const sql = readFileSync('supabase/migrations/20261113100000_core_remind_queue_rewrite.sql', 'utf8');
    const fns = [...sql.matchAll(/^create (?:or replace )?function private\.([a-z_]+)\([^)]*\)[\s\S]*?\$\$([\s\S]*?)\$\$;$/gm)].map((m) => ({ f: m[1] ?? '', src: m[2] ?? '' }));
    expect(fns.map((x) => x.f)).toEqual(['remind_enqueue', 'remind_reset', 'enqueue_remind', 'remind_on_settings', 'enqueue_floating', 'remind_queue_stats', 'touch', 'remind_queue_pop']);
    expect(fns.reduce((n, x) => n + (x.src.match(/insert into private\.remind_queue/g) ?? []).length, 0)).toBe(1);
    expect(leaseResetProblems(fns)).toEqual([]);
  });
});
