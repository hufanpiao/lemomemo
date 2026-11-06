// B2 安全审查 S-B2 服务器侧缺口补测（11-06，docs/06-测试/B2/B2-S-B2服务器侧证据清单.md 第七节）：
//   D1-2  url_mismatch：WHATWG 复核这一步。正则（SHAPE、点段、%2e）已把能让两边不一致的写法挡在前面，正常输入走不到——
//         这里 ① 按白名单允许的字符随机造 5000 条合格串，证明 new URL(s).href 与原串逐字相等（所以这一步是兜底）；
//         ② 换掉全局 URL，让解析结果和原串不一致、或解析抛错，证明兜底确实生效、回 url_mismatch。
//   C-2   salt、临时密钥只用 getRandomValues：supabase/functions 下（_shared/gen 生成目录除外）源码里不许出现 Math.random。
//   C-4   RFC 8291 密钥推导逐步中间值：在附录 A 输入上截下 ece.ts 每一步 Web Crypto 的输出（ECDH 共享密钥、IKM、CEK、NONCE、key_info），
//         和 node:crypto 另写的一份（createECDH + hkdfSync）逐字节比；整份正文仍和附录 A 一致。
//   C-8   VAPID 私钥只在内存、不进日志：私钥不可导出；loadVapid 各种失败只回原因码；push-dispatch 在配置错和正常发一轮时，
//         回包、deps.log、logs 表、console 输出里都没有私钥 d 和 JWK 原串。
import { createECDH, hkdfSync } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { b64uDecode, b64uEncode } from '../../supabase/functions/_shared/push/b64.ts';
import { checkEndpoint } from '../../supabase/functions/_shared/push/endpoint.ts';
import { encryptWithFixedKeysForTest } from '../../supabase/functions/_shared/push/ece.ts';
import { loadVapid } from '../../supabase/functions/_shared/push/vapid.ts';
import { handle } from '../../supabase/functions/push-dispatch/core.ts';
import { createFakePush, newPushSubscriber } from '../fakes/push-service.ts';
import { b64u, unb64u } from '../fakes/push-service-vapid.ts';
import { RFC8291 } from '../fixtures/rfc8291-appendix-a.ts';
import { cronReq, depsFor } from './push-dispatch-harness.ts';
import { MemDb, todoRow, UA, uuid } from './push-dispatch-mem.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------- D1-2 ----------------
describe('D1-2：WHATWG 复核（url_mismatch）', () => {
  const PATH_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~:/=&+-';
  const HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', 'a-1.push.apple.com', 'wns2-par02p.notify.windows.com'];
  let seed = 20261106;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const piece = (len: number) => Array.from({ length: len }, () => (rnd(10) === 0 ? `%${'0123456789ABCDEFabcdef'[rnd(22)]}${'0123456789ABCDEFabcdef'[rnd(22)]}` : PATH_CHARS[rnd(PATH_CHARS.length)])).join('');

  it('白名单允许的字符随机造 5000 条：凡是 checkEndpoint 收下的，new URL(s).href 都和原串逐字相等（这一步是兜底）', () => {
    let accepted = 0;
    for (let i = 0; i < 5000; i++) {
      const s = `https://${HOSTS[rnd(HOSTS.length)]}/${piece(1 + rnd(40))}${rnd(3) === 0 ? `?${piece(rnd(20))}` : ''}`;
      const r = checkEndpoint(s);
      if (!r.ok) {
        expect(r.reason).not.toBe('url_mismatch');
        continue;
      }
      accepted++;
      expect(new URL(s).href).toBe(s);
    }
    expect(accepted).toBeGreaterThan(1000);
  });
  it('换掉全局 URL：解析结果和原串不一致时回 url_mismatch', () => {
    const Real = URL;
    vi.stubGlobal('URL', class extends Real {
      override get href(): string { return `${super.href}x`; }
    });
    expect(checkEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toEqual({ ok: false, reason: 'url_mismatch' });
  });
  it('换掉全局 URL：主机名解析得不一样（比如 IDNA 换写）时回 url_mismatch', () => {
    const Real = URL;
    vi.stubGlobal('URL', class extends Real {
      override get hostname(): string { return 'evil.example'; }
    });
    expect(checkEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toEqual({ ok: false, reason: 'url_mismatch' });
  });
  it('换掉全局 URL：解析抛错时回 url_mismatch，不往外抛', () => {
    vi.stubGlobal('URL', class { constructor() { throw new TypeError('Invalid URL'); } });
    expect(checkEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toEqual({ ok: false, reason: 'url_mismatch' });
  });
});

// ---------------- C-2 ----------------
/** 这一行有没有用到 Math.random：点号（含 ?.）、方括号、解构（{ random } = Math、{ random: r } = globalThis.Math）三种写法 */
function isRandomUse(line: string): boolean {
  return /\bMath\s*(?:\?\.|\.)\s*random\b/.test(line)
    || /\bMath\s*\[\s*['"`]random['"`]\s*\]/.test(line)
    || /\{[^}]*\brandom\b[^}]*\}\s*=\s*(?:globalThis\s*\.\s*)?Math\b/.test(line);
}
describe('C-2：supabase/functions 下不许出现 Math.random', () => {
  it('扫描规则本身：几种写法都认得出；getRandomValues、普通的 random 变量、只解构别的不误报', () => {
    for (const bad of ['const x = Math.random();', "const r = Math['random']();", 'const { random } = Math;', 'const { random: r, floor } = Math;', 'const { random } = globalThis.Math;', 'x = Math?.random()', 'f(); // 行尾注释前的 Math.random() 也算']) {
      expect(isRandomUse(bad), bad).toBe(true);
    }
    for (const ok of ['crypto.getRandomValues(new Uint8Array(16));', 'const random = pick(xs);', 'const { floor } = Math;']) {
      expect(isRandomUse(ok), ok).toBe(false);
    }
  });
  it('除 _shared/gen（生成目录）外的 .ts 源码里没有 Math.random（只跳过整行以 // 开头的注释，行尾注释里的也算）', () => {
    const root = join(import.meta.dirname, '../../supabase/functions');
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) {
          if (relative(root, p).replace(/\\/g, '/') !== '_shared/gen') walk(p);
        } else if (p.endsWith('.ts')) {
          readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
            if (/^\s*\/\//.test(line)) return;   // 只跳过整行注释
            if (isRandomUse(line)) hits.push(`${relative(root, p)}:${i + 1}`);
          });
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});

// ---------------- C-4 ----------------
const A = RFC8291;   // RFC 8291 附录 A 向量，共用模块 tests/fixtures/rfc8291-appendix-a.ts
const hex = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('hex');

describe('C-4：RFC 8291 推导逐步中间值（附录 A 输入，node:crypto 另算一份对照）', () => {
  it('ECDH 共享密钥、key_info、IKM、CEK、NONCE 逐字节一致，AES-GCM 用的 iv 就是 NONCE，整份密文和附录 A 一致', async () => {
    // 独立实现：node:crypto 的 ECDH 和 HKDF（RFC 5869），不经 Web Crypto
    const uaPub = Buffer.from(b64uDecode(A.uaPublic) as Uint8Array);
    const asPub = Buffer.from(b64uDecode(A.asPublic) as Uint8Array);
    const auth = Buffer.from(b64uDecode(A.auth) as Uint8Array);
    const salt = Buffer.from(b64uDecode(A.salt) as Uint8Array);
    const ecdhNode = createECDH('prime256v1');
    ecdhNode.setPrivateKey(Buffer.from(b64uDecode(A.asPrivate) as Uint8Array));
    const ecdh = ecdhNode.computeSecret(uaPub);
    // 接收方一侧算出同一个共享密钥（ECDH 对称）
    const uaSide = createECDH('prime256v1');
    uaSide.setPrivateKey(Buffer.from(b64uDecode(A.uaPrivate) as Uint8Array));
    expect(hex(uaSide.computeSecret(asPub))).toBe(hex(ecdh));
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]);
    const ikm = Buffer.from(hkdfSync('sha256', ecdh, auth, keyInfo, 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

    // 截下 ece.ts 每一步 Web Crypto 的输入和输出
    const subtle = globalThis.crypto.subtle;
    const derived: { alg: string; info?: string; salt?: string; out: string }[] = [];
    const origDerive = subtle.deriveBits.bind(subtle);
    vi.spyOn(subtle, 'deriveBits').mockImplementation(async (alg, key, len) => {
      const out = await origDerive(alg, key, len);
      const a = alg as { name: string; info?: BufferSource; salt?: BufferSource };
      derived.push({ alg: a.name, ...(a.info ? { info: hex(new Uint8Array(a.info as ArrayBuffer)) } : {}), ...(a.salt ? { salt: hex(new Uint8Array(a.salt as ArrayBuffer)) } : {}), out: hex(out) });
      return out;
    });
    const ivs: string[] = [];
    const origEnc = subtle.encrypt.bind(subtle);
    vi.spyOn(subtle, 'encrypt').mockImplementation(async (alg, key, data) => {
      ivs.push(hex(new Uint8Array((alg as AesGcmParams).iv as ArrayBuffer)));
      return origEnc(alg, key, data);
    });
    const jwk = { d: A.asPrivate, x: b64u(unb64u(A.asPublic).slice(1, 33)), y: b64u(unb64u(A.asPublic).slice(33, 65)) };
    const record = new Uint8Array([...unb64u(A.plaintext), 2]);
    const out = await encryptWithFixedKeysForTest(record, uaPub, auth, jwk, salt);

    expect(derived.map((d) => d.alg)).toEqual(['ECDH', 'HKDF', 'HKDF', 'HKDF']);
    expect(derived[0]?.out).toBe(hex(ecdh));                                                   // ecdh_secret
    expect(derived[1]).toEqual({ alg: 'HKDF', info: hex(keyInfo), salt: hex(auth), out: hex(ikm) });   // PRK_key → IKM
    expect(derived[2]).toEqual({ alg: 'HKDF', info: hex(Buffer.from('Content-Encoding: aes128gcm\0')), salt: hex(salt), out: hex(cek) });
    expect(derived[3]).toEqual({ alg: 'HKDF', info: hex(Buffer.from('Content-Encoding: nonce\0')), salt: hex(salt), out: hex(nonce) });
    expect(ivs).toEqual([hex(nonce)]);
    expect(b64uEncode(out.slice(86))).toBe(A.ciphertext);
  });
});

// ---------------- C-8 ----------------
async function keypair() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']) as CryptoKeyPair;
  const j = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = b64u(new Uint8Array([4, ...unb64u(j.x ?? ''), ...unb64u(j.y ?? '')]));
  const raw = JSON.stringify({ kty: 'EC', crv: 'P-256', d: j.d, x: j.x, y: j.y });
  return { d: j.d as string, x: j.x as string, y: j.y as string, pub, raw };
}
/** 收集所有 console 输出 */
function captureConsole(): () => string {
  const lines: string[] = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x) ?? String(x))).join(' ')); });
  }
  return () => lines.join('\n');
}

describe('C-8：VAPID 私钥只在内存、不进日志', () => {
  it('loadVapid 成功：私钥对象不可导出（extractable = false），exportKey 拒绝；返回值序列化后没有 d', async () => {
    const k = await keypair();
    const r = await loadVapid(k.raw, k.pub, 'mailto:ops@lemomemo.com');
    if (!r.ok) throw new Error(r.reason);
    expect(r.keys.key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('jwk', r.keys.key)).rejects.toThrow();
    expect(JSON.stringify(r)).not.toContain(k.d);
  });
  it('loadVapid 各种失败只回原因码，返回值里没有 d、没有 JWK 原串', async () => {
    const k = await keypair();
    const other = await keypair();
    const cases: [string | undefined, string | undefined, string | undefined, string][] = [
      [JSON.stringify({ kty: 'EC', crv: 'P-256', d: k.d, x: other.x, y: other.y }), other.pub, 'mailto:a@b.com', 'vapid_bad_key|vapid_keypair_mismatch'],   // d 和 x、y 不是一对：Node 的 importKey 先拒（bad_key），别的运行时可能到自检才拒
      [k.raw, other.pub, 'mailto:a@b.com', 'vapid_keypair_mismatch'],
      [k.raw, k.pub, 'not-a-subject', 'vapid_bad_subject'],
      [JSON.stringify({ kty: 'EC', crv: 'P-384', d: k.d, x: k.x, y: k.y }), k.pub, 'mailto:a@b.com', 'vapid_bad_key'],
      [`${k.raw.slice(0, -1)}`, k.pub, 'mailto:a@b.com', 'vapid_bad_key'],
      [undefined, k.pub, 'mailto:a@b.com', 'vapid_missing'],
    ];
    for (const [priv, pub, sub, reason] of cases) {
      const r = await loadVapid(priv, pub, sub);
      expect(r.ok).toBe(false);
      expect(Object.keys(r).sort()).toEqual(['ok', 'reason']);
      expect(reason.split('|')).toContain((r as { reason: string }).reason);
      expect(JSON.stringify(r)).not.toContain(k.d);
    }
  });
  it('push-dispatch 配置错（私钥和公钥不是一对）：回 500 misconfigured，回包、deps.log、console 都没有 d', async () => {
    const k = await keypair();
    const other = await keypair();
    const out = captureConsole();
    const db = new MemDb();
    const codes: string[] = [];
    const d = { ...depsFor(db, (await loadVapid(other.raw, other.pub, 'mailto:a@b.com') as { ok: true; keys: never }).keys), vapid: () => loadVapid(k.raw, other.pub, 'mailto:a@b.com'), log: (c: string) => codes.push(c) };
    const res = await handle(cronReq(), d);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(codes).toEqual(['misconfigured:vapid_keypair_mismatch']);
    for (const s of [body, codes.join('\n'), out()]) {
      expect(s).not.toContain(k.d);
      expect(s).not.toContain(k.raw);
    }
  });
  it('push-dispatch 正常发一轮：回包、deps.log、logs 表、心跳、console、发出去的请求头里都没有 d', async () => {
    const k = await keypair();
    const v = await loadVapid(k.raw, k.pub, 'mailto:ops@lemomemo.com');
    if (!v.ok) throw new Error(v.reason);
    const out = captureConsole();
    const db = new MemDb();
    db.user(UA);
    const ep = `https://fcm.googleapis.com/fcm/send/${uuid('f')}`;
    const s = await newPushSubscriber(ep);
    db.device(UA, { endpoint: ep, p256dh: s.p256dh, auth: s.auth });
    const fake = createFakePush({ subscribers: [s], vapid: { publicKey: k.pub } });
    try {
      db.put('todos', todoRow(UA, { remind_at: Date.now() - 1000 }));
      const codes: string[] = [];
      const res = await handle(cronReq(), { ...depsFor(db, v.keys, { fetch: fake.fetch }), log: (c: string) => codes.push(c) });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(JSON.parse(body)).toMatchObject({ claimed: 1, sent: 1 });
      const all = [body, codes.join('\n'), JSON.stringify(db.logs), JSON.stringify(db.beats), out(), JSON.stringify(fake.requests.map((r) => r.headers))].join('\n');
      expect(all).not.toContain(k.d);
      expect(all).not.toContain(k.raw);
    } finally {
      await fake.close();
    }
  });
});
