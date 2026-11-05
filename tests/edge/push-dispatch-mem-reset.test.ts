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

describe('touch() 的提醒列：SQL、shared、替身三份一样（审查 M4）', () => {
  it('从 0001_core.sql 的 touch() 解析出 e.key in (...) 的列，和 TOUCH_REMIND_COLS、MEM_TOUCH_COLS 集合相等', () => {
    const sql = readFileSync(new URL('../../supabase/migrations/0001_core.sql', import.meta.url), 'utf8');
    const start = sql.indexOf('create function private.touch()');
    const body = sql.slice(start, sql.indexOf('end $$;', start));
    const m = /e\.key in \(([^)]*)\)/.exec(body);
    expect(m === null).toBe(false);
    const cols = [...(m?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect(cols.length).toBe(20);
    expect([...TOUCH_REMIND_COLS].sort()).toEqual(cols);
    expect([...MEM_TOUCH_COLS].sort()).toEqual(cols);
  });
  it('touch() 没有被后来的迁移重新定义（重新定义了就要改这条测试去解析最新那份）', () => {
    const dir = new URL('../../supabase/migrations/', import.meta.url);
    const hits = readdirSync(dir).filter((f) => f.endsWith('.sql') && /create\s+(or\s+replace\s+)?function\s+private\.touch\s*\(/i.test(readFileSync(new URL(f, dir), 'utf8')));
    expect(hits).toEqual(['0001_core.sql']);
  });
});
