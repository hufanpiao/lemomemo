// 出卡表白名单（K8 冲突提示方案 4.1，H2）：index.ts 的字面量（给 gate 用，A27 只许导出字面量）和 data/notice-tables.ts 是同一份
import { describe, expect, it } from 'vitest';
import { NOTICE_TABLES as DATA } from '../data/notice-tables.ts';
import { NOTICE_TABLES as INDEX } from '../index.ts';

describe('出卡表白名单', () => {
  it('两份一致，就是这五张表', () => {
    expect([...INDEX]).toEqual([...DATA]);
    expect([...DATA]).toEqual(['events', 'todos', 'anniversaries', 'categories', 'notes']);
  });
});
