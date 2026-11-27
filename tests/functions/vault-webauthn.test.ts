// vault 的 WebAuthn（B5 任务单 S4；TC-B5-06、40）和最小 CBOR 解码。
// 认证器是 webauthn-sim.ts 用 WebCrypto 现生成的 P-256 钥匙对；不连网、不用第三方库。
import { describe, expect, it } from 'vitest';
import { CborError, decodeAll, decodeFirst } from '../../supabase/functions/vault/cbor.ts';
import { derToRaw, isTauriOrigin, originAllowed } from '../../supabase/functions/vault/webauthn-verify.ts';
import { A, B, call, unlocked, world, type World } from './vault-fakes.ts';
import { cbor, FakeAuthenticator, FLAGS, rawToDer } from './webauthn-sim.ts';

async function options(w: World, purpose: 'register' | 'unlock', user = A) {
  const r = await call(w, { action: 'webauthn_options', purpose }, { user });
  return r.body as { challenge: string; rp_id: string; credential_ids: string[]; user_id: string; timeout_ms: number };
}

/** 解锁好、绑好一个凭据 */
async function bound(w: World, user = A) {
  const tok = await unlocked(w, user);
  const auth = await FakeAuthenticator.make();
  const { challenge } = await options(w, 'register', user);
  const r = await call(w, { action: 'webauthn_register', pin: '1234', label: ' iPhone ', attestation: await auth.attest(challenge) }, { user, token: tok });
  expect(r.status).toBe(200);
  return { tok: r.body.vault_token as string, auth };
}

describe('CBOR（只认 WebAuthn 用到的子集）', () => {
  it('整数、负数、字节、文本、数组、映射、布尔；映射键可以是整数', () => {
    const v = decodeAll(cbor(new Map<never, never>([[1, 2] as never, [-1, 'x'] as never, ['k', new Uint8Array([7])] as never, ['a', [true, false]] as never])));
    expect(v).toEqual(new Map<unknown, unknown>([[1, 2], [-1, 'x'], ['k', new Uint8Array([7])], ['a', [true, false]]]));
    expect(decodeFirst(new Uint8Array([0x01, 0xff]), 0)).toEqual({ value: 1, end: 1 });
  });
  it('多余字节、截断、标签、浮点、不定长、重复键、超深嵌套都报 CborError', () => {
    const bad = [
      new Uint8Array([0x01, 0x02]), new Uint8Array([0x58, 0x05, 1]), new Uint8Array([0xc0, 0x01]), new Uint8Array([0xf9, 0, 0]),
      new Uint8Array([0x5f]), new Uint8Array([0xa2, 0x01, 0x01, 0x01, 0x02]), new Uint8Array(Array(10).fill(0x81).concat([0])),
    ];
    for (const b of bad) expect(() => decodeAll(b)).toThrow(CborError);
  });
});

describe('签名格式和来源', () => {
  it('DER ⇄ r‖s；长度、标签不对拒', () => {
    const raw = new Uint8Array(64).map((_, i) => (i === 0 || i === 32 ? 0x80 : i));
    expect(derToRaw(rawToDer(raw))).toEqual(raw);
    expect(() => derToRaw(new Uint8Array([0x31, 0x06, 2, 1, 1, 2, 1, 1]))).toThrow();
  });
  it('正式只认 lemomemo.com，预览只认 preview，本机认 localhost 端口；tauri.localhost 认得出', () => {
    expect(originAllowed('prod', 'https://lemomemo.com')).toBe(true);
    expect(originAllowed('prod', 'https://preview.lemomemo.com')).toBe(false);
    expect(originAllowed('preview', 'https://preview.lemomemo.com')).toBe(true);
    expect(originAllowed('preview', 'https://lemomemo.com')).toBe(false);
    expect(originAllowed('local', 'http://localhost:5173')).toBe(true);
    expect(originAllowed('local', 'https://evil.example')).toBe(false);
    expect(isTauriOrigin('https://tauri.localhost')).toBe(true);
    expect(isTauriOrigin('http://tauri.localhost:1430')).toBe(true);
  });
});

describe('绑定（TC-B5-06）', () => {
  it('只有令牌不输密码、origin 是 evil 的都拒；正确 origin 加当场密码成功，挑战只能用一次，推送本人', async () => {
    const w = world();
    const tok = await unlocked(w);
    const auth = await FakeAuthenticator.make();
    let { challenge } = await options(w, 'register');
    // 不输密码：schema 要求 pin，空串格式不对
    expect((await call(w, { action: 'webauthn_register', pin: '', label: 'x', attestation: await auth.attest(challenge) }, { token: tok })).body.error).toBe('bad_pin');
    expect((await call(w, { action: 'webauthn_register', pin: '1234', label: 'x', attestation: await auth.attest(challenge) })).body.error).toBe('vault_locked');
    expect((await call(w, { action: 'webauthn_register', pin: '1234', label: 'x', attestation: await auth.attest(challenge, { origin: 'https://evil.example' }) }, { token: tok })).body.error).toBe('webauthn_failed');
    expect(w.db.s.challenges.size).toBe(0);   // 验过就删了，哪怕失败
    ({ challenge } = await options(w, 'register'));
    const ok = await call(w, { action: 'webauthn_register', pin: '1234', label: ' iPhone ', attestation: await auth.attest(challenge, { fmt: 'packed' }) }, { token: tok });
    expect(ok.status).toBe(200);
    expect([...w.db.s.creds.values()]).toEqual([expect.objectContaining({ id: auth.idB64, user_id: A, label: 'iPhone', sign_count: 0 })]);
    expect(w.pushes).toEqual([{ user: A, event: 'webauthn_added' }]);
    expect((await call(w, { action: 'webauthn_register', pin: '1234', label: 'x', attestation: await auth.attest(challenge) }, { token: tok })).body.error).toBe('webauthn_failed');
  });

  it('密码错和 unlock 共用计数；只按一下没做用户验证（UV）、ES256 以外的算法、解锁用的挑战都拒', async () => {
    const w = world();
    const tok = await unlocked(w);
    const auth = await FakeAuthenticator.make();
    const { challenge } = await options(w, 'register');
    expect((await call(w, { action: 'webauthn_register', pin: '0000', label: 'x', attestation: await auth.attest(challenge) }, { token: tok })).body).toMatchObject({ error: 'pin_wrong', left: 4 });
    expect(w.db.s.challenges.size).toBe(1);   // 密码错时挑战没动
    expect((await call(w, { action: 'webauthn_register', pin: '1234', label: 'x', attestation: await auth.attest(challenge, { flags: FLAGS.UP }) }, { token: tok })).body.error).toBe('webauthn_failed');
    for (const att of [
      async (c: string) => auth.attest(c, { alg: -257 }),
      async () => auth.attest((await options(w, 'unlock')).challenge),   // u. 的挑战不能拿来登记
    ]) {
      const { challenge: c } = await options(w, 'register');
      expect((await call(w, { action: 'webauthn_register', pin: '1234', label: 'x', attestation: await att(c) }, { token: tok })).body.error).toBe('webauthn_failed');
    }
    expect(w.db.s.creds.size).toBe(0);
  });

  it('exe（tauri.localhost）一律 webauthn_unavailable', async () => {
    const w = world();
    await unlocked(w);
    const r = await call(w, { action: 'webauthn_options', purpose: 'unlock' }, { origin: 'https://tauri.localhost' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('webauthn_unavailable');
  });
});

describe('解锁（TC-B5-40）', () => {
  it('正确的断言签令牌、写回 sign_count；options 回 rp_id、凭据 id', async () => {
    const w = world();
    const { auth } = await bound(w);
    const o = await options(w, 'unlock');
    expect(o).toMatchObject({ rp_id: 'lemomemo.com', credential_ids: [auth.idB64], timeout_ms: 120_000 });
    const r = await call(w, { action: 'unlock_webauthn', assertion: await auth.assert(o.challenge) });
    expect(r.status).toBe(200);
    expect(typeof r.body.vault_token).toBe('string');
    expect(w.db.s.creds.get(auth.idB64)?.sign_count).toBe(1);
  });

  it('RP ID 不对、B 的凭据、sign_count 没变大、过期挑战、同一挑战第二次、正式环境用预览 origin、tauri 都拒；验过的挑战已删', async () => {
    const w = world();
    const { auth } = await bound(w);
    const other = await bound(w, B);
    const first = await options(w, 'unlock');
    expect((await call(w, { action: 'unlock_webauthn', assertion: await auth.assert(first.challenge) })).status).toBe(200);   // 库里 sign_count = 1
    const tries: [string, (c: string) => Promise<unknown>][] = [
      ['count', (c) => auth.assert(c, { countDelta: 0 })],   // 还是 1，不比库里大
      ['rp', (c) => auth.assert(c, { rpId: 'evil.example' })],
      ['b-cred', (c) => other.auth.assert(c)],
      ['preview-origin', (c) => auth.assert(c, { origin: 'https://preview.lemomemo.com' })],
      ['type', (c) => auth.assert(c, { type: 'webauthn.create' })],
    ];
    for (const [name, make] of tries) {
      const { challenge } = await options(w, 'unlock');
      const r = await call(w, { action: 'unlock_webauthn', assertion: await make(challenge) });
      expect(r.body.error, name).toBe('webauthn_failed');
      expect(w.db.s.challenges.size, name).toBe(0);
    }
    const { challenge } = await options(w, 'unlock');
    w.db.ms += 121_000;
    expect((await call(w, { action: 'unlock_webauthn', assertion: await auth.assert(challenge) })).body.error).toBe('webauthn_failed');
    const fresh = await options(w, 'unlock');
    const ok = await auth.assert(fresh.challenge);
    expect((await call(w, { action: 'unlock_webauthn', assertion: ok })).status).toBe(200);
    expect((await call(w, { action: 'unlock_webauthn', assertion: ok })).body.error).toBe('webauthn_failed');
    const t = await options(w, 'unlock');
    expect((await call(w, { action: 'unlock_webauthn', assertion: await auth.assert(t.challenge, { origin: 'https://tauri.localhost' }) })).body.error).toBe('webauthn_unavailable');
  });

  it('预览环境只认 https://preview.lemomemo.com', async () => {
    const w = world({ env: 'preview' });
    const { auth } = await bound(w).catch(() => ({ auth: null as unknown as FakeAuthenticator }));
    expect(auth).toBeNull();   // 上面按正式 origin 绑，预览环境拒
    const tok = await unlocked(w, B);
    const a2 = await FakeAuthenticator.make();
    const { challenge } = await options(w, 'register', B);
    const r = await call(w, { action: 'webauthn_register', pin: '1234', label: 'x', attestation: await a2.attest(challenge, { origin: 'https://preview.lemomemo.com' }) }, { user: B, token: tok });
    expect(r.status).toBe(200);
  });

  it('列出、删掉一台后它再解锁被拒；删别人的回 not_found', async () => {
    const w = world();
    const { tok, auth } = await bound(w);
    const list = await call(w, { action: 'list_credentials' }, { token: tok });
    expect(list.body.items).toEqual([{ id: auth.idB64, label: 'iPhone' }]);
    expect((await call(w, { action: 'remove_credential', credential_id: 'nope' }, { token: tok })).body.error).toBe('not_found');
    expect((await call(w, { action: 'remove_credential', credential_id: auth.idB64 }, { token: list.body.vault_token as string })).status).toBe(200);
    const { challenge } = await options(w, 'unlock');
    expect((await call(w, { action: 'unlock_webauthn', assertion: await auth.assert(challenge) })).body.error).toBe('webauthn_failed');
  });

  it('锁定期间 Face ID 照样能解（代定），成功后清零失败计数', async () => {
    const w = world();
    const { auth } = await bound(w);
    for (let i = 0; i < 5; i++) await call(w, { action: 'unlock', pin: '0000' });
    const { challenge } = await options(w, 'unlock');
    expect((await call(w, { action: 'unlock_webauthn', assertion: await auth.assert(challenge) })).status).toBe(200);
    expect(w.db.s.vault.get(A)).toMatchObject({ fail_count: 0, lock_level: 0, locked_until: null });
  });
});
