// Face ID / Windows Hello 封装（platform/webauthn.ts；B5 S4、R-105、D18）：能不能用、base64url 编码、取消回 null
import { describe, expect, it, vi } from 'vitest';
import { createPasskey, fromB64u, getAssertion, toB64u, webauthnUsable, type WebauthnEnv } from '../webauthn.ts';

const env = (o: Partial<WebauthnEnv>): WebauthnEnv => ({ tauri: false, secure: true, api: true, platformAvailable: async () => true, ...o });
const OPTS = { challenge: toB64u(new Uint8Array([1, 2, 3])), rpId: 'lemomemo.com', timeoutMs: 60_000, userId: toB64u(new Uint8Array([9])), credentialIds: [toB64u(new Uint8Array([7, 7]))] };

describe('webauthnUsable', () => {
  it('exe、不安全上下文、没有 API、没有平台验证器：都不能用', async () => {
    expect(await webauthnUsable(env({ tauri: true }))).toBe(false);
    expect(await webauthnUsable(env({ secure: false }))).toBe(false);
    expect(await webauthnUsable(env({ api: false }))).toBe(false);
    expect(await webauthnUsable(env({ platformAvailable: async () => false }))).toBe(false);
    expect(await webauthnUsable(env({}))).toBe(true);
  });
});

describe('base64url', () => {
  it('来回一致、无填充、不含 + /', () => {
    const bytes = new Uint8Array([251, 255, 254, 0, 1]);
    const s = toB64u(bytes);
    expect(s).not.toMatch(/[+/=]/);
    expect([...fromB64u(s)]).toEqual([...bytes]);
  });
  it('服务器给的不是 base64url：抛（建凭据、取断言里按失败回 null）', () => {
    expect(() => fromB64u('a+b/')).toThrow();
  });
});

describe('createPasskey、getAssertion', () => {
  const buf = (n: number) => new Uint8Array([n]).buffer;
  it('绑定：平台验证器、要求验证用户；回 base64url 的三项', async () => {
    const create = vi.fn(async () => ({ rawId: buf(5), response: { clientDataJSON: buf(6), attestationObject: buf(7) } }));
    const r = await createPasskey(OPTS, 'a@b.c', { create } as unknown as CredentialsContainer);
    expect(r).toEqual({ id: toB64u(buf(5)), client_data_json: toB64u(buf(6)), attestation_object: toB64u(buf(7)) });
    const pk = (create.mock.calls[0] as unknown as [CredentialCreationOptions])[0].publicKey;
    expect(pk?.authenticatorSelection).toMatchObject({ authenticatorAttachment: 'platform', userVerification: 'required' });
    expect(pk?.rp.id).toBe('lemomemo.com');
    expect(pk?.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }]);   // 只声明服务器会验的 ES256（M4）
  });

  it('解锁：回四项；用户取消（抛 NotAllowedError）回 null', async () => {
    const get = vi.fn(async () => ({ rawId: buf(1), response: { clientDataJSON: buf(2), authenticatorData: buf(3), signature: buf(4) } }));
    expect(await getAssertion(OPTS, { get } as unknown as CredentialsContainer)).toEqual({
      id: toB64u(buf(1)), client_data_json: toB64u(buf(2)), authenticator_data: toB64u(buf(3)), signature: toB64u(buf(4)),
    });
    const cancel = vi.fn(async () => {
      throw new DOMException('cancel', 'NotAllowedError');
    });
    expect(await getAssertion(OPTS, { get: cancel } as unknown as CredentialsContainer)).toBeNull();
    expect(await createPasskey(OPTS, 'x', { create: cancel } as unknown as CredentialsContainer)).toBeNull();
  });
});
