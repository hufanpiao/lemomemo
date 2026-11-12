// 推送端点和订阅密钥的校验：TS 一侧唯一的一份（B2 安全审查 D1-1～D1-3、D1-S1、第五节第 1、3、4、6 条；架构 0.49 第 1 条、5.3“推送端点校验”）。
// push-dispatch、push-test 都只调这里；SQL 一侧是 private.push_endpoint_ok（迁移 20261103110000），两边各写一份常量，
// 同一组向量（tests/fixtures/push-endpoints.json；到之前先用 tests/shared/push/push-endpoint.test.ts 里的最小一组）各跑一遍、结论一致。
//
// **只收已经是规范形式的原串，不做任何规范化**（不转小写、不去末尾点）。比较一律区分大小写，不用 /i、/u。按顺序：
//   ① 纯 ASCII 可见字符 0x21～0x7E（空白、控制字符、非 ASCII 都拒）→ not_ascii；
//   ② 长度 ≤ 2048 → too_long；
//   ③ 以 https:// 开头 → bad_scheme；整串匹配 SHAPE_SOURCE（主机只许 [a-z0-9.-]；路径、查询串按 PATH_RULE，安全审查 1.5 第 ① 点），
//      原串里没有 %2e / %2E，? 之前的路径里没有单独成段的 . 或 .. → 否则 bad_format；
//   ④ 主机完全等于 fcm.googleapis.com、updates.push.services.mozilla.com，或是 *.push.apple.com、*.notify.windows.com 的一级子域
//      （标签 1～63 字符、不以 - 开头结尾、不以 xn-- 开头）→ 否则 host_not_allowed；
//   ⑤ 只在这一侧多做一步（D1-2）：new URL 解析后 href === 原串、hostname === ④ 的主机、没有端口、没有用户名密码、协议是 https
//      → 否则 url_mismatch（1.5 第 ①：这个字符集下 WHATWG 不改写原串，正常不会走到这里，是第二道保险；SQL 一侧没有这一步）。
// 通过以后发送时**原样用这个字符串**去 fetch，不再拼接、改写（D1-2）。日志只记 reason，不记地址（第五节第 6 条）。
// 不 import npm 包、不碰 Deno 全局；字符串字面量里不写 http(s):（tests/build/deno-config.test.ts 把它当远程模块），协议用正则判断。

import type { Bytes } from '../b64url.ts';

export const ENDPOINT_MAX = 2048;
/** 完全相等才认的两个主机 */
export const FIXED_HOSTS: readonly string[] = ['fcm.googleapis.com', 'updates.push.services.mozilla.com'];
/** 一级子域：Apple、Microsoft（WNS） */
const APPLE_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.push\.apple\.com$/;
const WNS_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.notify\.windows\.com$/;
const SCHEME = /^https:\/\//;
/**
 * 路径和查询串（安全审查 1.5 第 ① 点，取代 D1-1 第 ③ 步原来的 (/[^\#\s]*)）：路径以 / 开头、最多一个 ?、不许 #、% 后面正好两位十六进制。
 * 和迁移 20261103110000 里 private.push_endpoint_ok 的正则**一字不差**（tests/build/push-path-rule-sync.test.ts 逐字核对）。
 * 1.5 原文的 \? 写成 [?]、点段的 \. 写成 [.]（意思完全一样；check_backend F7 不许字符串里写反斜杠转义），SQL 一侧同样写法。
 * 只在这里改：SQL 一侧照抄这一串，fixture（tests/fixtures/push-endpoints.json）两边一起跑
 */
export const PATH_RULE = '(/(?:[A-Za-z0-9._~:/=&+-]|%[0-9A-Fa-f]{2})*)([?](?:[A-Za-z0-9._~:/=&+-]|%[0-9A-Fa-f]{2})*)?$';
const HOST_RULE = '([a-z0-9.-]+)';
/** 整串：^https://(主机)(路径)(?查询)?$，JS 一侧不加任何标志 */
export const SHAPE_SOURCE = `^${'https'}://${HOST_RULE}${PATH_RULE}`;
const SHAPE = new RegExp(SHAPE_SOURCE);
/** 编码过的点：原串里任何位置出现都拒（1.5 第 ①：.%2e、%2e%2e 这类变形不用一一列举） */
export const ENCODED_DOT = '%2[eE]';
/** 点段：只对 ? 之前的路径匹配 */
export const DOT_SEGMENT = '(^|/)[.]{1,2}(/|$)';
const ENCODED_DOT_RE = new RegExp(ENCODED_DOT);
const DOT_SEGMENT_RE = new RegExp(DOT_SEGMENT);

export type EndpointReason = 'not_ascii' | 'too_long' | 'bad_scheme' | 'bad_format' | 'host_not_allowed' | 'url_mismatch';
export type EndpointOk = {
  ok: true;
  /** 原串（发送时原样用） */
  url: string;
  /** https://<主机>，VAPID JWT 的 aud 和缓存键（D1-6） */
  origin: string;
  host: string;
  /** 主机属于 *.push.apple.com：一律不发 resolve（0.49 第 1 条） */
  apple: boolean;
};
export type EndpointCheck = EndpointOk | { ok: false; reason: EndpointReason };

function printableAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}

function hostAllowed(h: string): boolean {
  if (FIXED_HOSTS.includes(h)) return true;
  return (APPLE_HOST.test(h) || WNS_HOST.test(h)) && !h.startsWith('xn--');
}

export function checkEndpoint(s: unknown): EndpointCheck {
  if (typeof s !== 'string') return { ok: false, reason: 'bad_format' };
  if (!printableAscii(s)) return { ok: false, reason: 'not_ascii' };
  if (s.length > ENDPOINT_MAX) return { ok: false, reason: 'too_long' };
  if (!SCHEME.test(s)) return { ok: false, reason: 'bad_scheme' };
  const m = SHAPE.exec(s);
  if (!m || ENCODED_DOT_RE.test(s) || DOT_SEGMENT_RE.test(m[2] ?? '')) return { ok: false, reason: 'bad_format' };
  const host = m[1] ?? '';
  if (!hostAllowed(host)) return { ok: false, reason: 'host_not_allowed' };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: 'url_mismatch' };
  }
  if (u.href !== s || u.hostname !== host || u.port !== '' || u.username !== '' || u.password !== ''
      || u.protocol.slice(0, -1) !== 'https') {
    return { ok: false, reason: 'url_mismatch' };
  }
  return { ok: true, url: s, origin: u.origin, host, apple: APPLE_HOST.test(host) };
}

// ---------- 订阅密钥（D1-S1、C-3） ----------
// p256dh：^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]=?$，解码后 65 字节、首字节 0x04；auth：^[A-Za-z0-9_-]{21}[AQgw](==)?$，解码后 16 字节。
// 安全审查 1.5 D1-7 定稿。和 devices 的 check 约束、private.push_keys_ok 同一条正则（tests/build/push-path-rule-sync.test.ts 逐字核对），解码前先过正则。
// 点在不在曲线上正则查不出（SQL 照收），由 ece.ts 的 importKey 在发送时查、失败算 bad_keys——这是唯一允许 SQL 和 TS 结论不一致的情况（fixture 单列一组）
export const P256DH = /^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]=?$/;
export const AUTH = /^[A-Za-z0-9_-]{21}[AQgw](==)?$/;

export type KeysCheck = { ok: true; uaPublic: Bytes; authSecret: Bytes } | { ok: false; reason: 'bad_keys' };

function decodeFixed(s: string, chars: number, bytes: number): Bytes | null {
  const body = s.slice(0, chars).replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bin = atob(body + '='.repeat((4 - (chars % 4)) % 4));
    if (bin.length !== bytes) return null;
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function checkKeys(p256dh: unknown, auth: unknown): KeysCheck {
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !P256DH.test(p256dh) || !AUTH.test(auth)) return { ok: false, reason: 'bad_keys' };
  const uaPublic = decodeFixed(p256dh, 87, 65);
  const authSecret = decodeFixed(auth, 22, 16);
  if (!uaPublic || uaPublic[0] !== 4 || !authSecret) return { ok: false, reason: 'bad_keys' };
  return { ok: true, uaPublic, authSecret };
}
