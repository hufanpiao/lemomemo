// 出卡表白名单（K8 冲突提示方案 4.1，H2）：index.ts 的字面量（给 gate 用，A27 只许导出字面量）和 data/notice-tables.ts 是同一份
import { describe, expect, it } from 'vitest';
import { GONE_QUIET_TABLES as QUIET_DATA, NOTICE_TABLES as DATA } from '../data/notice-tables.ts';
import { GONE_QUIET_TABLES as QUIET_INDEX, NOTICE_TABLES as INDEX } from '../index.ts';

describe('出卡表白名单', () => {
  it('两份一致，就是这六张表（R-350 加 todo_items）；gone 静默的表两份一致、都在名单里', () => {
    expect([...INDEX]).toEqual([...DATA]);
    expect([...DATA]).toEqual(['events', 'todos', 'anniversaries', 'categories', 'notes', 'todo_items']);
    expect([...QUIET_INDEX]).toEqual([...QUIET_DATA]);
    expect([...QUIET_DATA]).toEqual(['todo_items']);
    for (const t of QUIET_DATA) expect(DATA).toContain(t);
  });
});
