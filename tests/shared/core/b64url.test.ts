// shared/core/b64url.ts（前端那份）：编码和 Node 的 base64url 逐字相同；严格解码；和服务器函数那份 supabase/functions/_shared/b64url.ts
// 拿同一批输入（合法、不合法都有）逐个对照，结果一模一样（两份不能互相 import，见两边文件头）。Node 和 Deno 都跑
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { b64uDecode, b64uEncode } from '../../../shared/core/b64url.ts';
import { b64uDecode as fnDecode, b64uEncode as fnEncode } from '../../../supabase/functions/_shared/b64url.ts';

const sample = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_v, i) => (i * 37 + n * 11) % 256);

describe('b64uEncode', () => {
  it('空数组得空串；会出 +、/ 和补位的字节只剩字母数字、-、_，不补 =', () => {
    expect(b64uEncode(new Uint8Array())).toBe('');
    expect(b64uEncode(new Uint8Array([0xfb, 0xff, 0xfe, 0x3e]))).toBe('-__-Pg');
  });
  it('0～69 字节都和 Node 的 base64url 一样；ArrayBuffer 和 Uint8Array 一样', () => {
    for (let n = 0; n < 70; n++) {
      const b = sample(n);
      expect(b64uEncode(b)).toBe(Buffer.from(b).toString('base64url'));
      expect(b64uEncode(b.slice().buffer)).toBe(b64uEncode(b));
    }
  });
});

describe('b64uDecode：严格', () => {
  it('合法的（带不带补位）解回原字节', () => {
    for (let n = 0; n < 70; n++) {
      const b = sample(n);
      const s = Buffer.from(b).toString('base64url');
      expect(b64uDecode(s)).toEqual(b);
      expect(b64uDecode(s + '='.repeat((4 - (s.length % 4)) % 4))).toEqual(b);
    }
  });
  it('标准 base64 的 + /、空白、别的字符、长度余 1、补位个数不对 → null', () => {
    for (const s of ['+/8', 'ab/c', ' QQ', 'QQ ', 'Q Q', '%%%', 'QQ=Q', 'A', 'AAAAA', 'QQ=', 'QQQ==', 'QQQQ=']) expect(b64uDecode(s), s).toBeNull();
  });
});

describe('和服务器函数那份逐个对照', () => {
  it('编码：0～300 字节结果相同', () => {
    for (let n = 0; n <= 300; n++) expect(b64uEncode(sample(n)), String(n)).toBe(fnEncode(sample(n)));
  });
  it('解码：合法、不合法、各种补位的串结果相同', () => {
    const inputs = ['', '=', '==', '====', 'A', 'AA', 'AAA', 'AAAA', 'AA==', 'AAA=', 'AAAA====', 'AA======', 'QR', 'Qx', 'QQ=Q', '+/8', 'a b', '-_-_', '%%', 'QQ\n'];
    for (let n = 0; n < 70; n++) {
      const s = Buffer.from(sample(n)).toString('base64url');
      inputs.push(s, `${s}=`, `${s}==`, `${s}===`, s.slice(1), `${s}!`);
    }
    for (const s of inputs) expect(b64uDecode(s), JSON.stringify(s)).toEqual(fnDecode(s));
  });
});
