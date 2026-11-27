// _shared/table-pager.ts（B7a 复审“重复和简化”）：每日备份和账号导出共用的主键收窄、翻页判断、每页行数、gzip。
// 两边原来各写一份，这里把两边原有的规则一条条再核一遍：换成共用的以后行为不变（两边的老测试 backup-daily、account-export-limits 照跑）。
import { describe, expect, it } from 'vitest';
import { GzipSink, concatBytes, gzipAll, keyOk, nextKey, pageSize } from '../../supabase/functions/_shared/table-pager.ts';
import { gunzip } from './account-export-harness.ts';

const U = '0b4f3c1e-2d5a-4b6c-8d7e-9f0a1b2c3d4e';
const NARROW = /^[a-z0-9._-]{1,64}$/;
const LIM = { firstPage: 50, page: 250, minPage: 10, wideRowBytes: 8 * 1024, pageRawBytes: 2 * 1024 * 1024 };

describe('keyOk：按主键类型收窄', () => {
  it('uuid 大小写都认、别的不认；int 只认安全整数；text 按调用方给的字符集；self 只能是本人', () => {
    expect([keyOk('uuid', U, U, NARROW), keyOk('uuid', U.toUpperCase(), U, NARROW), keyOk('uuid', 'x', U, NARROW), keyOk('uuid', 1, U, NARROW)]).toEqual([true, true, false, false]);
    expect([keyOk('int', 3, U, NARROW), keyOk('int', 2 ** 53, U, NARROW), keyOk('int', 1.5, U, NARROW), keyOk('int', '3', U, NARROW)]).toEqual([true, false, false, false]);
    expect([keyOk('text', 'theme.dark', U, NARROW), keyOk('text', 'a,b', U, NARROW), keyOk('text', 'A+/=', U, /^[A-Za-z0-9+/=]+$/)]).toEqual([true, false, true]);
    expect([keyOk('self', U, U, NARROW), keyOk('self', U.replace('0b', '1b'), U, NARROW)]).toEqual([true, false]);
  });
});

describe('nextKey：类型对、而且往前走了才回', () => {
  it('第一行（after 为 null）不比；uuid 统一小写；不前进、相等、类型不对回 undefined', () => {
    expect(nextKey('uuid', U.toUpperCase(), null, U, NARROW)).toBe(U);
    const lo = '00000000-0000-4000-8000-000000000001';
    expect(nextKey('uuid', U, lo, U, NARROW)).toBe(U);
    expect(nextKey('uuid', lo, U, U, NARROW)).toBeUndefined();
    expect(nextKey('uuid', U, U, U, NARROW)).toBeUndefined();
    expect(nextKey('int', 7, 6, U, NARROW)).toBe(7);
    expect(nextKey('int', 6, 6, U, NARROW)).toBeUndefined();
    expect(nextKey('uuid', 'not-a-uuid', null, U, NARROW)).toBeUndefined();
  });
});

describe('pageSize', () => {
  it('没有平均行宽取 firstPage；不宽取 page；宽行按 pageRawBytes ÷ 行宽，不少于 minPage、不多于 page', () => {
    expect(pageSize(undefined, LIM)).toBe(50);
    expect(pageSize(8 * 1024, LIM)).toBe(250);
    expect(pageSize(16 * 1024, LIM)).toBe(128);
    expect(pageSize(10 * 1024 * 1024, LIM)).toBe(10);
  });
});

describe('gzip 只有一份', () => {
  it('gzipAll：几段原文压成一个 gzip 成员，解开和原文一样', async () => {
    const enc = new TextEncoder();
    const gz = await gzipAll([enc.encode('{"rows":['), enc.encode('{"a":1}'), enc.encode(']}')]);
    expect(await gunzip(gz)).toBe('{"rows":[{"a":1}]}');
  });
  it('GzipSink：超过 1 MB 中途写进压缩流，raw 记原文字节数，各块拼起来是一个 gzip 成员', async () => {
    const g = new GzipSink();
    const line = `${'中'.repeat(1000)}\n`;
    let n = 0;
    for (let i = 0; i < 600; i++) { n += g.add(line); await g.flushIfBig(); }
    const { chunks, bytes } = await g.close();
    expect(g.raw).toBe(n);
    expect(n).toBeGreaterThan(1024 * 1024);
    expect(await gunzip(concatBytes(chunks, bytes))).toBe(line.repeat(600));
  });
});
