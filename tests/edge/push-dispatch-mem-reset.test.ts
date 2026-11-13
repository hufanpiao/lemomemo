// 替身 push-dispatch-mem.ts 的 edit() 和真库触发器逐条一致（清系统列三方对照的替身一半，复审 L8，11-05）：
// 向量读自 supabase/tests/rls/38_server_reset_parity.test.sql，纯函数一半在 tests/shared/server-reset.test.ts。
import { describe, expect, it } from 'vitest';
import type { ItemRow } from '../../supabase/functions/push-dispatch/round.ts';
import { fmtReset, loadResetVectors } from '../shared/server-reset-vectors.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { TOUCH_REMIND_COLS } from '../../shared/logic/server-reset.ts';
import { MEM_TOUCH_COLS, MemDb, UA } from './push-dispatch-mem.ts';

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

// R-411 迁移 20261113100000 起“哪些列算提醒输入”只有 private.table_meta.remind_cols 一份（touch() 只调 remind_reset，不再自己列列名）；
// 这里从这份迁移的三句 update 解析出三张表的并集，和 shared、替身比。清单 remindCols 接上 D1 比对以后改成对清单比（方案 4.6 ①）。
describe('提醒输入列：SQL（table_meta.remind_cols）、shared、替身三份一样（审查 M4）', () => {
  const REWRITE = '20261113100000_core_remind_queue_rewrite.sql';
  it('从迁移 20261113100000 的 table_meta.remind_cols 解析出三张表的并集，和 TOUCH_REMIND_COLS、MEM_TOUCH_COLS 集合相等', () => {
    const sql = readFileSync(new URL(`../../supabase/migrations/${REWRITE}`, import.meta.url), 'utf8');
    const sets = [...sql.matchAll(/^update private\.table_meta set remind_cols = '\{([a-z_,]+)\}'\s+where tbl = '([a-z]+)';$/gm)];
    expect(sets.map((m) => m[2]).sort()).toEqual(['anniversaries', 'events', 'todos']);
    const cols = [...new Set(sets.flatMap((m) => (m[1] ?? '').split(',')))].sort();
    expect(cols.length).toBe(20);
    expect([...TOUCH_REMIND_COLS].sort()).toEqual(cols);
    expect([...MEM_TOUCH_COLS].sort()).toEqual(cols);
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
