// 字节 → base64url（platform/b64url.ts）：和 Node 的 base64url 编码逐字相同
import { describe, expect, it } from 'vitest';
import { toB64u } from '../b64url.ts';

describe('toB64u', () => {
  it('空数组得空串', () => expect(toB64u(new Uint8Array())).toBe(''));

  it('会出 +、/ 和补位的字节：只剩字母数字、-、_，不补 =', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe, 0x3e]);
    expect(Buffer.from(bytes).toString('base64')).toBe('+//+Pg==');
    expect(toB64u(bytes)).toBe('-__-Pg');
  });

  it('各种长度都和 Node 的 base64url 一样', () => {
    for (let n = 0; n < 70; n++) {
      const bytes = Uint8Array.from({ length: n }, (_v, i) => (i * 37 + n * 11) % 256);
      expect(toB64u(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    }
  });
});
