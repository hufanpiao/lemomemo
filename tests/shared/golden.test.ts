// Node（三个进程时区）和 Deno 跑同一批输入，结果都必须等于 golden.json（架构 2.5、1.3 B0 验收）
// golden.json 由 build/update_golden.mjs 生成；改了时刻函数或词典的日期模板才需要重新生成，并人工看一遍差异
import { describe, expect, it } from 'vitest';
import golden from './golden.json' with { type: 'json' };
import { computeGolden } from './golden-cases.ts';

describe('golden：Node 和 Deno 结果一致', () => {
  it('210 行逐行相同', () => {
    const rows = computeGolden();
    expect(rows).toHaveLength(golden.length);
    for (let i = 0; i < rows.length; i++) expect(rows[i], `第 ${i} 行`).toEqual(golden[i]);
  });
});
