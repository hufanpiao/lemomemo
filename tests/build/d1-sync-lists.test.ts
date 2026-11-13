// D1 第 7 节（build/d1/sync-lists.ts syncListProblems，R-350 评审第 1 条）：tombstones_tbl_check、apply_patch 的 case、
// cleanup_batch 的 30 天清理三处手写名单，和清单的同步表逐张比对。真库一侧由 D1 本身（deno task d1、离线 PGlite）跑
import { describe, expect, it } from 'vitest';
import { CLEANUP_30D_EXEMPT, syncListProblems } from '../../build/d1/sync-lists.ts';

const SYNC = ['todos', 'todo_items', 'devices'];
const SOFT = ['todos', 'todo_items', 'devices'];
const tomb = (ts: string[]) => `CHECK ((tbl = ANY (ARRAY[${ts.map((t) => `'${t}'::text`).join(', ')}])))`;
const patch = (ts: string[]) => `cols := case p_table\n${ts.map((t) => `    when '${t}' then array['title','deleted_at']`).join('\n')}\n    else null end;\n  if p_table = 'notes' then null; end if;`;
const clean = (ts: string[]) => ts.map((t) => `  delete from public.${t.padEnd(14)} where ctid in (select ctid from public.${t.padEnd(14)} where deleted_at < cut30 limit left_);`).join('\n');
const good = { tombCheck: tomb(SYNC), applyPatch: patch(SYNC), cleanup: clean(['todos', 'todo_items']) };

describe('D1：三处手写的同步表名单和清单一致（sync-lists.ts，R-350 评审第 1 条）', () => {
  it('三处都对上：没有问题（devices 不走 30 天清理，是写明理由的豁免）', () => {
    expect(syncListProblems(good, SYNC, SOFT)).toEqual([]);
    expect(Object.keys(CLEANUP_30D_EXEMPT)).toEqual(['devices']);
  });

  it('tombstones_tbl_check 少一张、多一张都报', () => {
    expect(syncListProblems({ ...good, tombCheck: tomb(['todos', 'devices', 'notes']) }, SYNC, SOFT))
      .toEqual(['tombstones_tbl_check 的表名单和清单的同步表不一致：少了 todo_items；多了 notes']);
  });

  it('apply_patch 的 case 少了 todo_items 报；case 外面出现的表名（if p_table = …）不算', () => {
    expect(syncListProblems({ ...good, applyPatch: patch(['todos', 'devices']) }, SYNC, SOFT))
      .toEqual(['apply_patch 的 case p_table 表名单和清单的同步表不一致：少了 todo_items']);
  });

  it('cleanup_batch 漏了一张软删表的 30 天清理报；只出现在别的条件里（deleted_at < cut90）也报', () => {
    expect(syncListProblems({ ...good, cleanup: clean(['todos']) }, SYNC, SOFT))
      .toEqual(['cleanup_batch 没有清 todo_items 软删超过 30 天的行（要有 “public.todo_items where deleted_at < cut30”）']);
    const other = `${clean(['todos'])}\n  delete from public.todo_items where ctid in (select ctid from public.todo_items where deleted_at < cut90);`;
    expect(syncListProblems({ ...good, cleanup: other }, SYNC, SOFT)).toHaveLength(1);
  });

  it('表名是另一张表的前缀时不误认（有 public.todos 的清理不算有 public.todo 的）', () => {
    const two = ['todos', 'todo'];
    expect(syncListProblems({ tombCheck: tomb(two), applyPatch: patch(two), cleanup: clean(['todos']) }, two, two))
      .toEqual(['cleanup_batch 没有清 todo 软删超过 30 天的行（要有 “public.todo where deleted_at < cut30”）']);
  });

  it('约束或函数不在：各报一条', () => {
    expect(syncListProblems({ tombCheck: null, applyPatch: null, cleanup: null }, SYNC, SOFT))
      .toEqual(['tombstones_tbl_check 不在', 'public.apply_patch 不在', 'private.cleanup_batch 不在']);
  });
});
