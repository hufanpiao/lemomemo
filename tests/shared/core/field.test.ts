// shared/core/field.ts：str 不是字符串当空串、strOrNull 不是字符串当 null（空串照旧是空串）；只收一个参数，.map 直接用不会把下标当兜底值。Node 和 Deno 都跑
import { describe, expect, it } from 'vitest';
import { str, strOrNull } from '../../../shared/core/field.ts';

const odd: unknown[] = [null, undefined, 0, 1, true, {}, [], ['a'], new String('a')];

describe('str / strOrNull', () => {
  it('字符串原样返回（含空串、空白）', () => {
    for (const v of ['', ' ', 'a', '中文']) {
      expect(str(v)).toBe(v);
      expect(strOrNull(v)).toBe(v);
    }
  });
  it('不是字符串：str 给空串、strOrNull 给 null', () => {
    for (const v of odd) {
      expect(str(v)).toBe('');
      expect(strOrNull(v)).toBeNull();
    }
  });
  it('.map 直接用：下标不会被当成兜底值', () => {
    expect([1, 'b', null].map(str)).toEqual(['', 'b', '']);
    expect([1, 'b', null].map(strOrNull)).toEqual([null, 'b', null]);
  });
});
