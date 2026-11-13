// vault 的 WebAuthn 五个动作（架构 5.5；B5 任务单 S4；TC-B5-06、40）：webauthn_options、webauthn_register、unlock_webauthn、list_credentials、remove_credential。
// • 挑战：32 字节随机数，存 private.webauthn_challenges，主键写成 'r.<挑战>'（登记用）或 'u.<挑战>'（解锁用），两种不能串用；
//   有效 WEBAUTHN_CHALLENGE_TTL_S（2 分钟），验时先删再看过期——一个挑战只能用一次。不用加迁移（表只有 challenge、user_id、expires_at）。
// • 校验失败一律回 403 webauthn_failed，不说是哪一步没过；在事务里不抛错（抛了会回滚“删挑战、记失败次数”）。
// • 来源是 exe（tauri.localhost）一律 400 webauthn_unavailable（R-105）：先看请求头 Origin，clientDataJSON 里的 origin 再看一遍。
// • sign_count：两边都是 0 的放行（Apple 通行密钥始终报 0），否则新值必须大于库里的值（防克隆），成功后写回。
// 纯校验在 webauthn-verify.ts。
import { b64uEncode, concatBytes } from '../_shared/b64url.ts';
import { checkPin } from './pin.ts';
import { type Ctx, err, notifyLater, type Out, out, type ReqOf, type VaultTx } from './common.ts';
import {
  b64, checkClientData, checkRpAndFlags, isTauriOrigin, parseAuthData, readAttestation, readClientData, rpIdFor, sha256, verifyEs256, WebauthnError,
} from './webauthn-verify.ts';

const CHALLENGE_BYTES = 32;
const failed = () => err(403, 'webauthn_failed');
const unavailable = () => err(400, 'webauthn_unavailable');

/** 把校验里抛的 WebauthnError 换成响应（别的错照抛，事务回滚、回 try_later） */
async function guard(fn: () => Promise<Out | Response>): Promise<Out | Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof WebauthnError) return e.code === 'webauthn_unavailable' ? unavailable() : failed();
    throw e;
  }
}

/** UUID → 16 字节（WebAuthn 的 user.id） */
function uuidBytes(id: string): Uint8Array {
  const hex = id.replace(/-/g, '');
  const outB = new Uint8Array(16);
  for (let i = 0; i < 16; i++) outB.set([parseInt(hex.slice(i * 2, i * 2 + 2), 16)], i);
  return outB;
}

/** 取出这个挑战（删掉）；没有或过期就算校验失败。在别的校验之前做：挑战不管后面过没过都只能用一次（TC-B5-40） */
async function takeChallenge(c: Ctx, t: VaultTx, kind: 'r' | 'u', challenge: string): Promise<void> {
  const exp = await t.takeChallenge(`${kind}.${challenge}`);
  if (exp === null || exp <= c.deps.now()) throw new WebauthnError();
}

const fromExe = (c: Ctx) => isTauriOrigin(c.req.headers.get('origin'));

/** {webauthn_options, purpose}：发挑战；register 带 excludeCredentials，unlock 带 allowCredentials（同一个 credential_ids） */
export function options(c: Ctx, r: ReqOf<'webauthn_options'>): Promise<Out | Response> {
  if (fromExe(c)) return Promise.resolve(unavailable());
  const { rules, now, env } = c.deps;
  return c.deps.tx(c.userId, async (t) => {
    if (!(await t.vault(false))) return err(409, 'not_set');
    const challenge = b64uEncode(crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES)));
    await t.putChallenge(`${r.purpose === 'register' ? 'r' : 'u'}.${challenge}`, now() + rules.challengeTtlS * 1000);
    const creds = await t.credentials();
    return out({
      challenge, rp_id: rpIdFor(env, rules.rpId), timeout_ms: rules.challengeTtlS * 1000,
      user_id: b64uEncode(uuidBytes(c.userId)), credential_ids: creds.map((x) => x.id),
    }, null);
  });
}

/** {webauthn_register, pin, label, attestation}：要令牌（core.ts 已在同一事务里验过）+ 当场输对密码（和 unlock 共用失败计数） */
export function register(c: Ctx, t: VaultTx, r: ReqOf<'webauthn_register'>): Promise<Out | Response> {
  if (fromExe(c)) return Promise.resolve(unavailable());
  const { env, rules } = c.deps;
  return guard(async () => {
    const row = await t.vault(true);
    if (!row) return err(409, 'not_set');
    const bad = await checkPin(c, t, row, r.pin);
    if (bad) return bad;
    const cd = b64(r.attestation.client_data_json);
    const v = readClientData(cd);
    await takeChallenge(c, t, 'r', v.challenge);
    checkClientData(v, 'webauthn.create', env);
    const a = await readAttestation(b64(r.attestation.attestation_object), cd, env, rules.rpId);
    const id = b64uEncode(a.credentialId);
    if (id !== r.attestation.id) return failed();
    const label = r.label.trim() || null;
    if (!(await t.insertCredential({ id, public_key: a.publicKey, sign_count: a.signCount, label }))) return failed();
    notifyLater(c, 'webauthn_added');
    return out({}, null);
  });
}

/** {unlock_webauthn, assertion}：不要令牌；成功签令牌。pin 锁定期间照样放行（代定：生物识别本身就是更强的验证），成功后清零失败计数 */
export function unlockWebauthn(c: Ctx, r: ReqOf<'unlock_webauthn'>): Promise<Out | Response> {
  if (fromExe(c)) return Promise.resolve(unavailable());
  const { env, rules } = c.deps;
  return c.deps.tx(c.userId, (t) => guard(async () => {
    const row = await t.vault(true);
    if (!row) return err(409, 'not_set');
    const cd = b64(r.assertion.client_data_json);
    const v = readClientData(cd);
    await takeChallenge(c, t, 'u', v.challenge);
    checkClientData(v, 'webauthn.get', env);
    const cred = await t.credential(r.assertion.id);
    if (!cred) return failed();
    const ad = b64(r.assertion.authenticator_data);
    const a = parseAuthData(ad, false);
    await checkRpAndFlags(a, env, rules.rpId);
    if (!(await verifyEs256(cred.public_key, b64(r.assertion.signature), concatBytes(ad, await sha256(cd))))) return failed();
    if ((a.signCount !== 0 || cred.sign_count !== 0) && a.signCount <= cred.sign_count) return failed();
    if (a.signCount !== cred.sign_count) await t.setSignCount(cred.id, a.signCount);
    if (row.fail_count !== 0 || row.lock_level !== 0 || row.locked_until !== null) await t.updateVault({ fail_count: 0, lock_level: 0, locked_until: null });
    return out({}, row.pin_epoch);
  }));
}

/** {list_credentials}：要令牌 */
export async function listCredentials(t: VaultTx): Promise<Out> {
  const creds = await t.credentials();
  return out({ items: creds.map((x) => ({ id: x.id, label: x.label })) }, null);
}

/** {remove_credential, credential_id}：要令牌；不是本人的、没有的回 not_found */
export async function removeCredential(t: VaultTx, r: ReqOf<'remove_credential'>): Promise<Out | Response> {
  return (await t.deleteCredential(r.credential_id)) ? out({}, null) : err(404, 'not_found');
}
