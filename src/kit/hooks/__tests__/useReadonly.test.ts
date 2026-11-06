// kit 的只读行钩子（FA-2）：repeatPendingOf 只数只读、还在用、repeat 不为空的行
import { describe, expect, it } from 'vitest';
import { repeatPendingOf } from '../useRepeatPending.ts';

describe('repeatPendingOf', () => {
  it('只读 + repeat 不为空 + 没删没撤销才算', () => {
    const rows = [
      { id: 'a', repeat: { freq: 'week' }, deleted_at: null },
      { id: 'b', repeat: { freq: 'week' }, deleted_at: null },   // 不是只读（新版改成可写了）
      { id: 'c', repeat: null, deleted_at: null },                // 只读，但原因是别的不认识的值
      { id: 'd', repeat: { freq: 'day' }, deleted_at: 5 },        // 删了
      { id: 'e', repeat: { freq: 'day' }, undone: true },         // 撤销了
      { id: 'f', repeat: 'FREQ=DAILY' },                          // 新版本的格式不认识也算
    ];
    expect(repeatPendingOf(rows, new Set(['a', 'c', 'd', 'e', 'f']))).toBe(2);
    expect(repeatPendingOf(rows, new Set())).toBe(0);
  });
});
