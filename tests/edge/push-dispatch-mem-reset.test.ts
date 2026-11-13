// 替身 push-dispatch-mem.ts 的 edit() 和真库触发器逐条一致（清系统列三方对照的替身一半，复审 L8，11-05）：
// 向量读自 supabase/tests/rls/38_server_reset_parity.test.sql，纯函数一半在 tests/shared/server-reset.test.ts。
import { describe, expect, it } from 'vitest';
import type { ItemRow } from '../../supabase/functions/push-dispatch/round.ts';
import { fmtReset, loadResetVectors } from '../shared/server-reset-vectors.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { TOUCH_REMIND_COLS } from '../../shared/logic/server-reset.ts';
import { MEM_TOUCH_COLS, MemDb, UA } from './push-dispatch-mem.ts';
import { allManifests } from '../../shared/manifests/index.ts';
import { tableSchema } from '../../shared/schema/manifest.ts';

const { vectors, plan } = loadResetVectors();

describe('替身 edit()：清系统列和 rls/38 的真库期望一致', () => {
  it('向量全读到了', () => {
    expect(vectors.length).toBe(plan);
  });
  it('逐条一致', () => {
    const db = new MemDb().user(UA);
    vectors.forEach((v, i) => {
      const id = `r38-${i}`;
      db.tables[v.table].set(id, { ...v.old, id, user_id: UA } as unknown as ItemRow);
      expect(fmtReset(v.table, db.edit(v.table, id, v.applied as Partial<ItemRow>) as unknown as Record<string, unknown>), v.name).toBe(v.want);
    });
  });
});

// R-411 起“哪些列算提醒输入”只有清单的 remindCols 一个源头（shared/manifests/calendar.ts、todos.ts、anniv.ts）：
// 迁移 20261113100000 把它写进 private.table_meta.remind_cols，D1 第 8 节在库里逐表比对（反例 d1-fixtures/49）；
// 这里再静态比一次迁移的三句 update，并让 shared 的 TOUCH_REMIND_COLS、替身的 MEM_TOUCH_COLS 都等于三张表的并集（审查 M4）。
describe('提醒输入列：清单 remindCols、迁移（table_meta.remind_cols）、shared、替身一致', () => {
  const REWRITE = '20261113100000_core_remind_queue_rewrite.sql';
  const byTable = new Map(allManifests.flatMap((m) => m.tables).filter((t) => t.remindCols).map((t) => [t.name, [...(t.remindCols ?? [])]]));
  it('清单只有三张表写了 remindCols，迁移的三句 update 逐表逐字一致', () => {
    expect([...byTable.keys()].sort()).toEqual(['anniversaries', 'events', 'todos']);
    const sql = readFileSync(new URL(`../../supabase/migrations/${REWRITE}`, import.meta.url), 'utf8');
    const sets = [...sql.matchAll(/^update private\.table_meta set remind_cols = '\{([a-z_,]+)\}'\s+where tbl = '([a-z]+)';$/gm)];
    expect(new Map(sets.map((m) => [m[2], (m[1] ?? '').split(',')]))).toEqual(byTable);
  });
  it('三张表的并集（20 列）= TOUCH_REMIND_COLS = MEM_TOUCH_COLS', () => {
    const cols = [...new Set([...byTable.values()].flat())].sort();
    expect(cols.length).toBe(20);
    expect([...TOUCH_REMIND_COLS].sort()).toEqual(cols);
    expect([...MEM_TOUCH_COLS].sort()).toEqual(cols);
  });
  it('清单规则 manifest_remind_cols：只写在挂 touch() 的表上、不为空、只放客户端可写列', () => {
    const todos = allManifests.flatMap((m) => m.tables).find((t) => t.name === 'todos');
    if (!todos) throw new Error('没有 todos');
    const parse = (over: Record<string, unknown>) => tableSchema.safeParse({ ...todos, ...over });
    expect(parse({}).success).toBe(true);
    const why = (over: Record<string, unknown>) => { const r = parse(over); return r.success ? 'ok' : r.error.issues.map((i) => i.message).join(','); };
    expect(why({ remindCols: [] })).toBe('manifest_remind_cols');
    expect(why({ remindCols: ['due', 'remind_at'] })).toBe('manifest_remind_cols');   // 系统列算提醒输入：push-dispatch 写回就会再入队
    expect(why({ systemCols: undefined, noConflict: undefined })).toBe('manifest_remind_cols');
  });
  it('touch() 只在 0001 和 20261113100000 定义过，最新那份不再自己列提醒列、只调一次 remind_reset（再被重新定义就要改这条测试）', () => {
    const dir = new URL('../../supabase/migrations/', import.meta.url);
    const re = /create\s+(or\s+replace\s+)?function\s+private\.touch\s*\(/i;
    const hits = readdirSync(dir).filter((f) => f.endsWith('.sql') && re.test(readFileSync(new URL(f, dir), 'utf8')));
    expect(hits).toEqual(['0001_core.sql', REWRITE]);
    const sql = readFileSync(new URL(REWRITE, dir), 'utf8');
    const start = sql.search(re);
    const body = sql.slice(start, sql.indexOf('end $$;', start));
    expect(body).not.toMatch(/pushed_for|e\.key in/);
    expect(body.match(/private\.remind_reset\(/g)?.length).toBe(1);
  });
});
