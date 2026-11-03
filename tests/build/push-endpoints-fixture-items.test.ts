// tests/fixtures/push-endpoints.json 按子项核（代码审查 S10）：安全审查第六节第 1～44 条里点名的每个原串，以及 1.5 第 ③ 点（D1-7）
// 点名的密钥样例，都要在 fixture 里、期望结果对。只查条号的话，某一条下的子项漏了也看不出来。
// 原串照第六节抄；只写了路径的（第 42 条）按 fixture 用的前缀补全
import { describe, expect, it } from 'vitest';
import { fx } from './push-endpoints-fixture-load.ts';

const F = 'https://fcm.googleapis.com';
const FQ = `${F}/fcm/send/`;
const WQ = 'https://wns2-par02p.notify.windows.com/w/?token=';
const APPLE = 'push.apple.com';

/** 第六节点名、必须判不合格的原串，按条号 */
const MUST_REJECT: Record<number, readonly string[]> = {
  1: ['http://fcm.googleapis.com/fcm/send/x'],
  2: ['HTTPS://fcm.googleapis.com/fcm/send/x'],
  3: ['https:fcm.googleapis.com/fcm/send/x', 'https:/fcm.googleapis.com/fcm/send/x', 'https:///fcm.googleapis.com/fcm/send/x'],
  4: ['wss://fcm.googleapis.com/x', 'javascript:alert(1)', 'data:,x', 'file:///etc/passwd'],
  5: ['//fcm.googleapis.com/x', '', '   '],
  6: [` ${F}/x`, `${F}/x `, `${F}/x\n`],
  7: [F, `${F}?x=1`],
  8: [`https://evil.com#.web.${APPLE}/x`],
  9: [`https://evil.com?.web.${APPLE}/x`],
  10: [`https://evil.com\\.web.${APPLE}/x`, 'https://fcm.googleapis.com\\@evil.com/x'],
  11: ['https://fcm.googleapis.com@evil.com/x', 'https://user:pass@fcm.googleapis.com/x', 'https://@fcm.googleapis.com/x', 'https://:@fcm.googleapis.com/x'],
  12: ['https://fcm.googleapis.com.evil.com/x', `https://web.${APPLE}.evil.com/x`],
  13: ['https://evilpush.apple.com/x', 'https://evil-fcm.googleapis.com/x', 'https://xfcm.googleapis.com/x'],
  14: [`https://${APPLE}/x`, 'https://notify.windows.com/x'],
  15: [`https://a.web.${APPLE}/x`, 'https://a.b.notify.windows.com/x'],
  16: [`https://.${APPLE}/x`, `https://web..${APPLE}/x`],
  17: [`https://-web.${APPLE}/x`, `https://web-.${APPLE}/x`],
  18: [`https://${'a'.repeat(64)}.${APPLE}/x`],
  19: [`https://xn--zz.${APPLE}/x`, 'https://xn--web-abc.notify.windows.com/x'],
  20: ['https://android.googleapis.com/gcm/send/x', 'https://googleapis.com/x', 'https://updates.push.services.mozilla.com.evil.com/x'],
  21: [`https://WEB.${APPLE}/x`, 'https://Fcm.googleapis.com/x'],
  22: [`https://web.${APPLE}./x`, 'https://fcm.googleapis.com../x'],
  23: ['https://web%2epush%2eapple%2ecom/x', 'https://fcm%2Egoogleapis.com/x', `https://evil.com%2f.web.${APPLE}/x`, `https://evil.com%23.web.${APPLE}/x`],
  24: ['https://fcm．googleapis．com/x', 'https://fcm.googleapis。com/x', 'https://web.push.apple｡com/x'],
  25: ['https://fcm.googleapiſ.com/x', `https://wеb.${APPLE}/x`, 'https://ｆｃｍ.googleapis.com/x'],
  26: [`https://web.${APPLE}\t.evil.com/x`, `${F}\n/x`, 'https://fcm.goo\tgleapis.com/x'],
  27: [`${F}:443/x`],
  28: [`${F}:/x`],
  29: [`${F}:8443/x`, `${F}:0443/x`, `https://web.${APPLE}:65536/x`],
  30: ['https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.1/x'],
  31: ['https://2130706433/x', 'https://0x7f000001/x', 'https://0177.0.0.1/x', 'https://127.1/x'],
  32: ['https://[::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://[::ffff:7f00:1]/x', 'https://[fe80::1%25eth0]/x'],
  33: ['https://localhost/x', 'https://kong:8000/x', 'https://host.docker.internal/x'],
  37: [`${F}/x#frag`, `${F}/a\\b`, `${F}/a b`],
  40: [...'"<>^`{}|'.split('').map((c) => `${FQ}a${c}b`), `${FQ}a{b}`],
  41: "'!$()*,;@[]".split('').map((c) => `${WQ}a${c}b`),
  42: [...['/a/../b', '/a/./b', '/..', '/.', '/a/..', '/a/%2e%2e/b', '/a/.%2e/b', '/a/%2E/b'].map((p) => F + p), `${WQ}%2e`],
  43: ['/a%', '/a%2', '/a%zz'].map((p) => F + p),
  44: [`${WQ}a?b`],
};

const byEndpoint = new Map(fx.endpoints.map((e) => [e.endpoint, e]));

describe('第六节点名的原串：每个子项都在 fixture 里，判不合格，ref 是对应条号', () => {
  const rows = Object.entries(MUST_REJECT).flatMap(([n, list]) => list.map((s) => [Number(n), s] as const));
  it.each(rows)('第 %i 条：%j', (n, s) => {
    const e = byEndpoint.get(s);
    expect(e, '缺这一条').toBeDefined();
    expect(e?.ok).toBe(false);
    expect(e?.ref).toBe(`6 第 ${n} 条`);
  });

  it('第 26 条：主机里带 NUL 的那条在（只在 Deno 一侧跑）', () => {
    expect(fx.endpoints.some((e) => !e.ok && e.endpoint.includes('\u0000') && e.pg === false)).toBe(true);
  });

  it('第 34、35、36 条：2049 拒、2048 合格、10 万字符拒', () => {
    const at = (n: number) => fx.endpoints.filter((e) => e.endpoint.length === n);
    expect(at(2049).map((e) => [e.ok, e.ref])).toEqual([[false, '6 第 34 条']]);
    expect(at(2048).every((e) => e.ok && e.ref === '6 第 35 条')).toBe(true);
    expect(at(100_000).map((e) => [e.ok, e.ref])).toEqual([[false, '6 第 36 条']]);
  });

  it('1.5 第 ① 点“不收的字符”：路径里的 @ 也拒，ref 写 1.5 节', () => {
    expect(byEndpoint.get(`${FQ}a@b`)).toMatchObject({ ok: false, ref: '1.5 第 ① 点' });
  });
});

describe('1.5 第 ③ 点（D1-7）点名的密钥样例', () => {
  const p = fx.keys.filter((k) => k.field === 'p256dh');
  const a = fx.keys.filter((k) => k.field === 'auth');
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  it.each(B64.slice(16).split(''))('p256dh 第 2 个字符是 %s 的有一条，判不合格', (c) => {
    expect(p.some((k) => !k.ok && k.value.length === 87 && k.value[0] === 'B' && k.value[1] === c)).toBe(true);
  });

  it('p256dh：末字符不是 4 的倍数（含 B）、88 个字符以 == 结尾，判不合格', () => {
    expect(p.some((k) => !k.ok && k.value.length === 87 && k.value.endsWith('B'))).toBe(true);
    expect(p.some((k) => !k.ok && k.value.length === 88 && k.value.endsWith('=='))).toBe(true);
  });

  it('p256dh 合格组：BA、BP 开头，末字符 0、w，带补齐和不带补齐都有', () => {
    const ok = p.filter((k) => k.ok);
    expect(ok.some((k) => k.value.startsWith('BA'))).toBe(true);
    expect(ok.some((k) => k.value.startsWith('BP'))).toBe(true);
    expect(ok.some((k) => k.value.replace(/=$/, '').endsWith('0'))).toBe(true);
    expect(ok.some((k) => k.value.replace(/=$/, '').endsWith('w'))).toBe(true);
    expect(ok.some((k) => k.value.length === 87)).toBe(true);
    expect(ok.some((k) => k.value.length === 88)).toBe(true);
  });

  it('auth：末字符 A、Q、g、w 各有合格的；末字符 B、R 和只补一个 = 的判不合格', () => {
    for (const c of 'AQgw') expect(a.some((k) => k.ok && k.value.length === 22 && k.value.endsWith(c)), c).toBe(true);
    for (const c of 'BR') expect(a.some((k) => !k.ok && k.value.length === 22 && k.value.endsWith(c)), c).toBe(true);
    expect(a.some((k) => !k.ok && k.value.length === 23 && k.value.endsWith('='))).toBe(true);
  });
});
