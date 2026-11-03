// 向量由 build/gen_push_endpoints.py 生成（python -I build/gen_push_endpoints.py，结果固定、逐字节可复现），改样例请改脚本再重新生成，不要手改 JSON。
// tests/fixtures/push-endpoints.json 的自检（B2 TC-B2-80 的向量；B2-安全审查-S-B2签字 D1-1、D1-2、D1-7、1.5 第 ①③ 点、第六节）：
// ① 格式和条数：合格、不合格各 ≥ 15 条，id、原串不重复，安全审查第六节第 1～44 条每条都有样例、11-03 补充的合格写法都在；
// ② 用一份独立的参考实现逐条核对 ok——向量本身写错了，后端两边“结果一致”也没有意义；
// ③ 合格的每一条还要过 D1-2（WHATWG 解析后 href 原样不变、主机一致、无端口和用户名），保证 SQL 收下的 Deno 也收下；
// ④ 10 万字符那条参考实现要很快判完（安全审查第六节第 36 条：两边都不能超时）；
// ⑤ keysSendOnly（不在曲线上的公钥）正则合格、解码合格，但 Web Crypto 导入失败——只在发送时报 bad_keys，不进两边一致的比对。
// 第六节逐个子项的原串在 push-endpoints-fixture-items.test.ts 里核。
// 这里的参考实现只为核对向量，不是给后端用的实现（后端的唯一实现在 supabase/functions/_shared/，安全审查 D1-3）
import { describe, expect, it } from 'vitest';

import { fx, type KeyCase } from './push-endpoints-fixture-load.ts';

/** 路径和查询串里允许的一个字符（安全审查 1.5 第 ① 点；两边写法一字不差） */
const PART = '(?:[A-Za-z0-9._~:/=&+-]|%[0-9A-Fa-f]{2})';
const SHAPE = new RegExp(`^https://([a-z0-9.-]+)(/${PART}*)(\\?${PART}*)?$`);

/** 安全审查 D1-1（第 ③ 步按 1.5 第 ① 点改过）：只收规范写法的原串 */
function endpointOk(s: string): boolean {
  if (!/^[\x21-\x7e]+$/.test(s)) return false; // ① 只含可见 ASCII（空串、空白、控制字符、非 ASCII 都拒）
  if (s.length > 2048) return false; // ②
  const m = SHAPE.exec(s); // ③
  const host = m?.[1];
  const path = m?.[2];
  if (host === undefined || path === undefined) return false;
  if (s.includes('%2e') || s.includes('%2E')) return false; // 原串里不许有编码的点
  if (/(^|\/)\.{1,2}(\/|$)/.test(path)) return false; // 路径（? 之前）不许有点段
  if (host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com') return true; // ④
  const sub = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.(?:push\.apple\.com|notify\.windows\.com)$/.exec(host)?.[1];
  return sub !== undefined && !sub.startsWith('xn--');
}

/** 安全审查 D1-2：Deno 一侧再用 WHATWG 解析核一遍 */
function whatwgAgrees(s: string): boolean {
  const host = /^https:\/\/([^/]+)\//.exec(s)?.[1];
  const u = new URL(s);
  return u.href === s && u.hostname === host && u.port === '' && u.username === '' && u.password === '' && u.protocol === 'https:';
}

function importP256(v: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', Buffer.from(v.replace(/=+$/, ''), 'base64url'), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

function b64uBytes(s: string): number {
  return Buffer.from(s.replace(/=+$/, ''), 'base64url').length;
}

/** 安全审查 D1-7（1.5 第 ③ 点，11-03 定稿） */
function keyOk(field: KeyCase['field'], v: string): boolean {
  if (field === 'p256dh') return /^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]=?$/.test(v);
  return /^[A-Za-z0-9_-]{21}[AQgw](==)?$/.test(v);
}

const KEY_REF = /^(6 第 3[89] 条|1\.5 第 ③ 点 D1-7)$/;

describe('push-endpoints.json：格式和条数', () => {
  it('顶层字段齐全，version 是 1', () => {
    expect(fx.version).toBe(1);
    expect(Array.isArray(fx.endpoints)).toBe(true);
    expect(Array.isArray(fx.keys)).toBe(true);
  });

  it('每条端点有 id、endpoint、ok、why；不合格的有 ref；pg 只能写 false 且要写 pgWhy', () => {
    for (const e of fx.endpoints) {
      expect(typeof e.id, JSON.stringify(e.id)).toBe('string');
      expect(typeof e.endpoint, e.id).toBe('string');
      expect(typeof e.ok, e.id).toBe('boolean');
      expect(e.why.length, e.id).toBeGreaterThan(0);
      if (!e.ok) expect(e.ref, e.id).toMatch(/^(6 第 \d+ 条|1\.5 第 ① 点)$/);
      if (e.ref !== undefined) expect(e.ref, e.id).toMatch(/^(6 第 \d+ 条|6 合格组|6 补充合格组|1\.5 第 ① 点)$/);
      if (e.pg !== undefined) {
        expect(e.pg, e.id).toBe(false);
        expect(e.pgWhy?.length, e.id).toBeGreaterThan(0);
      }
    }
  });

  it('合格、不合格各 ≥ 15 条；id 和原串都不重复', () => {
    expect(fx.endpoints.filter((e) => e.ok).length).toBeGreaterThanOrEqual(15);
    expect(fx.endpoints.filter((e) => !e.ok).length).toBeGreaterThanOrEqual(15);
    const ids = [...fx.endpoints, ...fx.keys, ...fx.keysSendOnly].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const eps = fx.endpoints.map((e) => e.endpoint);
    expect(new Set(eps).size).toBe(eps.length);
  });

  it('安全审查第六节第 1～37、40～44 条（35 在合格组）每条都有端点样例，38、39 在密钥组', () => {
    const refs = new Set(fx.endpoints.map((e) => e.ref));
    const nums = [...Array.from({ length: 37 }, (_, i) => i + 1), 40, 41, 42, 43, 44];
    for (const n of nums) expect(refs.has(`6 第 ${n} 条`), `第 ${n} 条`).toBe(true);
    const keyRefs = new Set(fx.keys.map((k) => k.ref));
    expect(keyRefs.has('6 第 38 条')).toBe(true);
    expect(keyRefs.has('6 第 39 条')).toBe(true);
  });

  it('第六节 11-03 补充的合格写法每条都在、都判合格', () => {
    const want = [
      'https://fcm.googleapis.com/a..b',
      'https://fcm.googleapis.com/a.b/',
      'https://fcm.googleapis.com/.well',
      'https://wns2-par02p.notify.windows.com/w/?token=a%2Bb%3D',
      'https://wns2-par02p.notify.windows.com/w/?token=a%2bb%3d',
      'https://fcm.googleapis.com/fcm/send/x?',
      'https://fcm.googleapis.com/fcm/send/abc:APA91b-x_y',
      'https://updates.push.services.mozilla.com/wpush/v2/a~b+c=d&e',
    ];
    for (const w of want) expect(fx.endpoints.find((e) => e.endpoint === w)?.ok, w).toBe(true);
  });

  it('长度边界：2048 合格、2049 拒、10 万字符拒', () => {
    const byLen = (n: number) => fx.endpoints.filter((e) => e.endpoint.length === n);
    expect(byLen(2048).map((e) => e.ok)).toContain(true);
    expect(byLen(2049).map((e) => e.ok)).toEqual([false]);
    expect(byLen(100_000).map((e) => e.ok)).toEqual([false]);
  });

  it('只有含 NUL 的那条标 pg: false（PostgreSQL 的 text 放不下）', () => {
    for (const e of fx.endpoints) expect(e.pg === false, e.id).toBe(e.endpoint.includes('\u0000'));
  });

  it('密钥组：p256dh、auth 各有合格和不合格；ref 只能是第 38、39 条或 D1-7；值不重复', () => {
    for (const f of ['p256dh', 'auth'] as const) {
      expect(fx.keys.some((k) => k.field === f && k.ok)).toBe(true);
      expect(fx.keys.some((k) => k.field === f && !k.ok)).toBe(true);
    }
    for (const k of fx.keys) if (k.ref !== undefined || !k.ok) expect(k.ref, k.id).toMatch(KEY_REF);
    const vals = fx.keys.map((k) => `${k.field}:${k.value}`);
    expect(new Set(vals).size).toBe(vals.length);
  });

  it('keysSendOnly：至少 2 条，全标 sqlOk: true、sendOk: false', () => {
    expect(fx.keysSendOnly.length).toBeGreaterThanOrEqual(2);
    for (const k of fx.keysSendOnly) expect([k.field, k.sqlOk, k.sendOk, k.ref], k.id).toEqual(['p256dh', true, false, '1.5 第 ③ 点 D1-7']);
  });
});

describe('push-endpoints.json：每条 ok 和参考实现一致', () => {
  it.each(fx.endpoints.map((e) => [e.id, e] as const))('%s', (_, e) => {
    expect(endpointOk(e.endpoint), e.why).toBe(e.ok);
    if (e.ok) expect(whatwgAgrees(e.endpoint), `${e.why}：WHATWG 解析后变了，SQL 和 Deno 会不一致`).toBe(true);
  });

  it.each(fx.keys.map((k) => [k.id, k] as const))('%s', async (_, k) => {
    expect(keyOk(k.field, k.value), k.why).toBe(k.ok);
    if (k.ok) expect(b64uBytes(k.value)).toBe(k.field === 'p256dh' ? 65 : 16);
    if (k.ok && k.field === 'p256dh') expect(Buffer.from(k.value.replace(/=+$/, ''), 'base64url')[0]).toBe(0x04);
    // 合格的 p256dh 都是真在曲线上的点（否则发送时会报 bad_keys，和“两边一致”这一组的意思不符）
    if (k.ok && k.field === 'p256dh') await expect(importP256(k.value)).resolves.toBeDefined();
  });

  it.each(fx.keysSendOnly.map((k) => [k.id, k] as const))('%s（只在发送时拒）', async (_, k) => {
    expect(keyOk('p256dh', k.value), `${k.why}：正则应当合格（SQL 收下）`).toBe(true);
    expect(b64uBytes(k.value)).toBe(65);
    await expect(importP256(k.value), `${k.why}：Web Crypto 应当拒`).rejects.toThrow();
  });

  it('10 万字符那条 50 毫秒内判完', () => {
    const long = fx.endpoints.find((e) => e.endpoint.length === 100_000);
    expect(long).toBeDefined();
    const t = performance.now();
    expect(endpointOk(long?.endpoint ?? '')).toBe(false);
    expect(performance.now() - t).toBeLessThan(50);
  });
});
