// Face ID / Windows Hello（WebAuthn）
// • exe 一律不能用（服务器也会回 webauthn_unavailable）；没有 PublicKeyCredential、不是安全上下文、平台验证器不可用时也不显示按钮，只给“输入密码”
// • 服务器收发 base64url（无填充），编解码只用 shared/core/b64url.ts 那一份
// • 绑定和解锁只调 navigator.credentials，不联网；挑战由 vault 的 webauthn_options 发
// • 算法只声明 ES256（-7）：服务器只验 ES256（vault/webauthn-verify.ts），声明别的会绑出一个永远验不过的凭据
// • 用户取消、认不出、超时一律返回 null（界面按“没认出来”算，连续两次换成密码键盘）
import { b64uDecode, b64uEncode, type Bytes } from '../../shared/core/b64url.ts';
import { isTauri } from './env.ts';

export const toB64u = (buf: ArrayBuffer | Uint8Array): string => b64uEncode(buf);

/** 服务器给的 base64url → 字节；不合格就抛（调用处 try 住，按失败回 null） */
export function fromB64u(s: string): Bytes {
  const b = b64uDecode(s);
  if (!b) throw new Error('bad_b64u');
  return b;
}

export interface WebauthnEnv {
  tauri: boolean;
  secure: boolean;
  api: boolean;
  platformAvailable(): Promise<boolean>;
}

function defaultEnv(): WebauthnEnv {
  const g = globalThis as { PublicKeyCredential?: { isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean> } };
  return {
    tauri: isTauri(),
    secure: typeof isSecureContext === 'boolean' ? isSecureContext : false,
    api: typeof g.PublicKeyCredential === 'function' && typeof navigator !== 'undefined' && !!navigator.credentials,
    platformAvailable: async () => (await g.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.()) === true,
  };
}

/** 这台设备能不能显示 Face ID / Windows Hello：结论和原因（原因进运行日志，看得出是哪一关没过） */
export type WebauthnWhy = 'ok' | 'tauri' | 'insecure' | 'no_api' | 'no_platform' | 'platform_err';

export async function webauthnCheck(env: WebauthnEnv = defaultEnv()): Promise<WebauthnWhy> {
  if (env.tauri) return 'tauri';
  if (!env.secure) return 'insecure';
  if (!env.api) return 'no_api';
  try {
    return (await env.platformAvailable()) ? 'ok' : 'no_platform';
  } catch {
    return 'platform_err';
  }
}

export interface WebauthnOptions {
  challenge: string;
  rpId: string;
  timeoutMs: number;
  /** register 用：user.id（base64url） */
  userId: string;
  /** register：excludeCredentials；unlock：allowCredentials */
  credentialIds: readonly string[];
}

export interface Attestation {
  id: string;
  client_data_json: string;
  attestation_object: string;
}

export interface Assertion {
  id: string;
  client_data_json: string;
  authenticator_data: string;
  signature: string;
}

const ALGS: PublicKeyCredentialParameters[] = [{ type: 'public-key', alg: -7 }];   // ES256（服务器只认这一种）

const ids = (list: readonly string[]): PublicKeyCredentialDescriptor[] =>
  list.map((id) => ({ type: 'public-key', id: fromB64u(id) }));

/** 绑定：建平台凭据；取消、失败回 null */
export async function createPasskey(o: WebauthnOptions, userName: string, creds: CredentialsContainer = navigator.credentials): Promise<Attestation | null> {
  try {
    const c = (await creds.create({
      publicKey: {
        challenge: fromB64u(o.challenge),
        rp: { id: o.rpId, name: 'Lemo' },
        user: { id: fromB64u(o.userId), name: userName, displayName: userName },
        pubKeyCredParams: ALGS,
        timeout: o.timeoutMs,
        excludeCredentials: ids(o.credentialIds),
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        attestation: 'none',
      },
    })) as PublicKeyCredential | null;
    const r = c?.response as AuthenticatorAttestationResponse | undefined;
    if (!c || !r) return null;
    return { id: toB64u(c.rawId), client_data_json: toB64u(r.clientDataJSON), attestation_object: toB64u(r.attestationObject) };
  } catch {
    return null;
  }
}

/** 解锁：用已绑定的凭据签挑战；取消、认不出回 null */
export async function getAssertion(o: WebauthnOptions, creds: CredentialsContainer = navigator.credentials): Promise<Assertion | null> {
  try {
    const c = (await creds.get({
      publicKey: {
        challenge: fromB64u(o.challenge),
        rpId: o.rpId,
        timeout: o.timeoutMs,
        allowCredentials: ids(o.credentialIds),
        userVerification: 'required',
      },
    })) as PublicKeyCredential | null;
    const r = c?.response as AuthenticatorAssertionResponse | undefined;
    if (!c || !r) return null;
    return {
      id: toB64u(c.rawId),
      client_data_json: toB64u(r.clientDataJSON),
      authenticator_data: toB64u(r.authenticatorData),
      signature: toB64u(r.signature),
    };
  } catch {
    return null;
  }
}
