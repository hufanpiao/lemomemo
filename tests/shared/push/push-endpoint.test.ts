// supabase/functions/_shared/push/endpoint.ts（TC-B2-80 的 Deno / Node 一侧；B2 安全审查 D1-1～D1-3、D1-S1）
// 向量读测试开发维护的 tests/fixtures/push-endpoints.json（SQL 一侧是由它生成的 supabase/tests/rls/29_push_endpoint_vectors.test.sql，两边逐条对同一个 ok）。
// Node（vitest）和 Deno（deno task test）各跑一遍
import { describe, expect, it } from 'vitest';
import { checkEndpoint, checkKeys } from '../../../supabase/functions/_shared/push/endpoint.ts';
import fixture from '../../fixtures/push-endpoints.json' with { type: 'json' };

const HTTPS = ['https', '://'].join('');   // 拼出来，免得字面量被当成远程地址（只在测试里）

interface Fx {
  endpoints: { id: string; endpoint: string; ok: boolean; why: string; pg?: boolean }[];
  keys: { id: string; field: 'p256dh' | 'auth'; value: string; ok: boolean; why: string }[];
}
const FX = fixture as unknown as Fx;
const GOOD_AUTH = 'A'.repeat(22);
const GOOD_P256DH = 'BA' + 'A'.repeat(85);

// 只在 TS 一侧多做的 WHATWG 核对用不到（③ 的字符集已经排除）；这几条是“SQL 和 TS 都要拒”的额外写法，SQL 一侧靠 /. 和字符集
const EXTRA_BAD: readonly string[] = [
  `${HTTPS}fcm.googleapis.com/a/../x`,
  `${HTTPS}fcm.googleapis.com/a/%2e%2e/x`,
  `${HTTPS}fcm.googleapis.com/a{b}`,
  `${HTTPS}fcm.googleapis.com/a"b`,
  `${HTTPS}fcm.googleapis.com/?a'b`,
];

describe('checkEndpoint', () => {
  it('fixture 端点逐条：ok 和期望一致；合格的返回原串和 origin', () => {
    expect(FX.endpoints.length).toBeGreaterThan(30);
    for (const e of FX.endpoints) {
      const r = checkEndpoint(e.endpoint);
      expect(r.ok, `${e.id} ${e.why}`).toBe(e.ok);
      if (r.ok) {
        expect(r.url).toBe(e.endpoint);
        expect(r.origin).toBe(`${HTTPS}${r.host}`);
      }
    }
  });
  it(`fixture 之外“SQL 和 TS 都要拒”的 ${EXTRA_BAD.length} 条也拒（SQL 一侧在 28_claim_endpoint.test.sql）`, () => {
    for (const s of EXTRA_BAD) expect(checkEndpoint(s).ok, JSON.stringify(s.slice(0, 60))).toBe(false);
  });
  it('非字符串、10 万字符都拒，不超时', () => {
    expect(checkEndpoint(null).ok).toBe(false);
    expect(checkEndpoint(42).ok).toBe(false);
    const t0 = Date.now();
    expect(checkEndpoint(`${HTTPS}fcm.googleapis.com/${'a'.repeat(100_000)}`)).toEqual({ ok: false, reason: 'too_long' });
    expect(checkEndpoint('a'.repeat(100_000)).ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it('原因码：not_ascii、too_long、bad_scheme、bad_format、host_not_allowed（日志只记这个，不记地址）', () => {
    expect(checkEndpoint(`${HTTPS}fcm。googleapis.com/x`)).toEqual({ ok: false, reason: 'not_ascii' });
    expect(checkEndpoint(`${HTTPS}fcm.googleapis.com/${'a'.repeat(2022)}`)).toEqual({ ok: false, reason: 'too_long' });
    expect(checkEndpoint('http://fcm.googleapis.com/x')).toEqual({ ok: false, reason: 'bad_scheme' });
    expect(checkEndpoint(`${HTTPS}fcm.googleapis.com:443/x`)).toEqual({ ok: false, reason: 'bad_format' });
    expect(checkEndpoint(`${HTTPS}evil.example/x`)).toEqual({ ok: false, reason: 'host_not_allowed' });
  });
  it('apple 只按主机判断（*.push.apple.com 不发 resolve）', () => {
    const a = checkEndpoint(`${HTTPS}web.push.apple.com/x`);
    const f = checkEndpoint(`${HTTPS}fcm.googleapis.com/x`);
    expect(a.ok && a.apple).toBe(true);
    expect(f.ok && f.apple).toBe(false);
  });
});

describe('checkKeys（D1-S1、C-3）', () => {
  const K = 'BA' + 'A'.repeat(85);
  const A = 'A'.repeat(22);
  it('fixture 密钥逐条：ok 和期望一致', () => {
    expect(FX.keys.length).toBeGreaterThan(10);
    for (const k of FX.keys) {
      const r = k.field === 'p256dh' ? checkKeys(k.value, GOOD_AUTH) : checkKeys(GOOD_P256DH, k.value);
      expect(r.ok, `${k.id} ${k.why}`).toBe(k.ok);
    }
  });
  it('合格：87 字符、末尾带一个 =；auth 22 字符、带 ==', () => {
    expect(checkKeys(K, A).ok).toBe(true);
    expect(checkKeys(K + '=', A + '==').ok).toBe(true);
    const r = checkKeys(K, A);
    expect(r.ok && r.uaPublic.length).toBe(65);
    expect(r.ok && r.uaPublic[0]).toBe(4);
    expect(r.ok && r.authSecret.length).toBe(16);
  });
  it('不合格：长度、首字符不是 B、首字节不是 0x04、= 在中间、标准 base64 的 + /、非 ASCII、空串', () => {
    const bad: [unknown, unknown][] = [
      ['BA' + 'A'.repeat(83), A], ['BA' + 'A'.repeat(86), A], ['AA' + 'A'.repeat(85), A], ['BQ' + 'A'.repeat(85), A],
      ['BA' + 'A'.repeat(40) + '=' + 'A'.repeat(44), A], ['BA' + 'A'.repeat(84) + '+', A], ['BA' + 'A'.repeat(84) + '/', A],
      ['BA' + 'A'.repeat(84) + 'é', A], ['', A],
      [K, 'A'.repeat(21)], [K, 'A'.repeat(25)], [K, 'A'.repeat(10) + '=' + 'A'.repeat(11)], [K, 'A'.repeat(21) + '+'], [K, ''],
      [null, A], [K, undefined],
    ];
    for (const [k, a] of bad) expect(checkKeys(k, a).ok, `${String(k).slice(0, 12)}…/${String(a)}`).toBe(false);
  });
});
