// Face ID / Windows Hello（WebAuthn，B5 S4；架构 5.5、R-105、代定 D18）
// • 能不能用：exe（tauri.localhost，isTauri）一律不能用（服务器也会回 webauthn_unavailable）；没有 PublicKeyCredential、
//   不是安全上下文、平台验证器不可用时也不显示按钮，只给“输入密码”
// • 编码：服务器收发 base64url（无填充），这里负责 ArrayBuffer ↔ base64url
// • 绑定（register）和解锁（get）只调浏览器的 navigator.credentials，不联网；挑战由 vault 的 webauthn_options 发
// • 用户取消、认不出、超时一律返回 null（界面按“没认出来”算，连续两次换成密码键盘，D18）
import { isTauri } from './env.ts';

export function toB64u(buf: ArrayBuffer | ArrayBufferView): string {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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
    platformAvailable: async () => {
      try {
        return (await g.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.()) === true;
      } catch {
        return false;
      }
    },
  };
}

/** 这台设备能不能显示 Face ID / Windows Hello：exe 不能；没有 API、不安全上下文、没有平台验证器都不能 */
export async function webauthnUsable(env: WebauthnEnv = defaultEnv()): Promise<boolean> {
  if (env.tauri || !env.secure || !env.api) return false;
  return env.platformAvailable();
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

const ALGS: PublicKeyCredentialParameters[] = [
  { type: 'public-key', alg: -7 },     // ES256
  { type: 'public-key', alg: -257 },   // RS256（Windows Hello 常见）
];

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
