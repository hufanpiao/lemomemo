// Face ID / Windows Hello（WebAuthn，B5 S4；架构 5.5、R-105、代定 D18）
// • 能不能用：exe（tauri.localhost，isTauri）一律不能用（服务器也会回 webauthn_unavailable）；没有 PublicKeyCredential、
//   不是安全上下文、平台验证器不可用时也不显示按钮，只给“输入密码”
// • 编码：服务器收发 base64url（无填充），编解码用 shared/core/b64url.ts（前端只用这一份，11-14 独立评审：原来这里另写了一份）
// • 绑定（register）和解锁（get）只调浏览器的 navigator.credentials，不联网；挑战由 vault 的 webauthn_options 发
// • 算法只声明 ES256（-7）：服务器只验 ES256（vault/webauthn-verify.ts 的 verifyEs256），声明别的会绑出一个永远验不过的凭据
// • 用户取消、认不出、超时一律返回 null（界面按“没认出来”算，连续两次换成密码键盘，D18）
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
