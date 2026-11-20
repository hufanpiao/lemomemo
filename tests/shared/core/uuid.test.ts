// shared/core/uuid.ts：默认只认小写的整串 UUID；anyCase 为 true 时大写、混写也认（原来带 /i 的那几处）；不是字符串一律 false。Node 和 Deno 都跑
import { describe, expect, it } from 'vitest';
import { isUuid } from '../../../shared/core/uuid.ts';

const LOW = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const UP = LOW.toUpperCase();
const MIXED = '0190A1b2-c3d4-7E5f-8a9b-0c1d2e3f4a5b';

describe('isUuid', () => {
  it('小写整串两种写法都认', () => {
    expect(isUuid(LOW)).toBe(true);
    expect(isUuid(LOW, true)).toBe(true);
  });
  it('大写、混写：默认不认，anyCase 才认', () => {
    for (const v of [UP, MIXED]) {
      expect(isUuid(v)).toBe(false);
      expect(isUuid(v, true)).toBe(true);
    }
  });
  it('不是整串、位数不对、多了空白、带花括号都不认', () => {
    for (const v of ['', `${LOW}0`, LOW.slice(1), ` ${LOW}`, `${LOW}\n`, `{${LOW}}`, LOW.replace(/-/g, ''), 'g190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b']) {
      expect(isUuid(v)).toBe(false);
      expect(isUuid(v, true)).toBe(false);
    }
  });
  it('不是字符串一律 false', () => {
    for (const v of [null, undefined, 1, {}, [LOW], { toString: () => LOW }]) {
      expect(isUuid(v)).toBe(false);
      expect(isUuid(v, true)).toBe(false);
    }
  });
});
