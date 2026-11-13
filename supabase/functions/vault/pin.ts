// vault 的密码几件事：status、setup、unlock、change_pin、reset，以及逐级锁定（架构 5.5；B5 任务单 S2、S3 后半；TC-B5-01～05、16）。
// • pin_hash = HMAC-SHA256(VAULT_PIN_PEPPER, user_id:pin) 的十六进制，常数时间比较（_shared/vault-crypto.ts）；
// • 连错 VAULT_FAILS_PER_LEVEL（5）次锁一次，时长按 lockSeconds(lock_level)（1 分 → 5 分 → 15 分 → 1 小时 → 4 小时 → 之后 24 小时），lock_level 加 1、
//   fail_count 清零；每次锁定推送本人所有设备。锁上的那一次和锁定期间，unlock、change_pin、webauthn_register 一律 423 pin_locked（带 retry_after_s；
//   11-14 整块评审第 6 条：原来锁上那一次回 pin_wrong、left 0，前端没据此设锁定时刻）。输对：fail_count、lock_level 清零；
// • change_pin 和 unlock 共用同一个 fail_count；change_pin、reset 成功后 pin_epoch 加 1、删全部 vault_credentials 和 device_secrets、推送；
// • reset 看 JWT amr 里 otp 的 timestamp 在 10 分钟内（_shared/otp-fresh.ts，不看 iat），写 last_reset_at、发重设邮件、记 logs。
// 不打印 pin、哈希；日志只记错误码。
import { otpFresh } from '../_shared/otp-fresh.ts';
import { hexEqual, pinHash } from '../_shared/vault-crypto.ts';
import { type Base, type Ctx, err, notifyLater, type Out, out, type ReqOf, type VaultRow, type VaultTx } from './common.ts';

const secs = (ms: number) => Math.max(1, Math.ceil(ms / 1000));
const locked = (untilMs: number, now: number) => err(423, 'pin_locked', { retry_after_s: secs(untilMs - now) });

const hashOf = (c: Ctx, pin: string): Promise<string> => pinHash(c.keys.pepper, c.userId, pin);

/**
 * 锁定中回 423；核对密码：对了清零失败计数、回 null；不对记一次失败，回 403 pin_wrong（带 left，1～4）；第 5 次锁上并推送，回 423 pin_locked。
 * 错的这一次写进库：调用方不能抛错（抛了整个事务回滚，失败就不算数了）
 */
export async function checkPin(c: Ctx, t: VaultTx, row: VaultRow, pin: string): Promise<Response | null> {
  const { rules, now } = c.deps;
  const at = now();
  if (row.locked_until !== null && row.locked_until > at) return locked(row.locked_until, at);
  if (!rules.pinRe.test(pin)) return err(400, 'bad_pin');   // 格式不对的不可能对，不算一次失败
  if (hexEqual(await hashOf(c, pin), row.pin_hash)) {
    if (row.fail_count !== 0 || row.lock_level !== 0 || row.locked_until !== null) await t.updateVault({ fail_count: 0, lock_level: 0, locked_until: null });
    return null;
  }
  const fails = row.fail_count + 1;
  if (fails >= rules.failsPerLevel) {
    const s = rules.lockSeconds(row.lock_level);
    await t.updateVault({ fail_count: 0, lock_level: row.lock_level + 1, locked_until: at + s * 1000 });
    notifyLater(c, 'locked');
    c.deps.log('pin_locked');
    return locked(at + s * 1000, at);
  }
  await t.updateVault({ fail_count: fails });
  return err(403, 'pin_wrong', { left: rules.failsPerLevel - fails });
}

/** {status}：设没设过、锁到几时、上次重设、绑了几个凭据（不要令牌、不签令牌） */
export function status(c: Base): Promise<Out> {
  return c.deps.tx(c.userId, async (t) => {
    const row = await t.vault(false);
    if (!row) return out({ set: false, locked_until: null, last_reset_at: null, webauthn: 0 }, null);
    const at = c.deps.now();
    const creds = await t.credentials();
    return out({
      set: true, locked_until: row.locked_until !== null && row.locked_until > at ? row.locked_until : null,
      last_reset_at: row.last_reset_at, webauthn: creds.length,
    }, null);
  });
}

/** {setup, pin}：只在还没有记录时执行（否则 already_set）；成功就算解锁，签令牌 */
export async function setup(c: Ctx, r: ReqOf<'setup'>): Promise<Out | Response> {
  if (!c.deps.rules.pinRe.test(r.pin)) return err(400, 'bad_pin');
  const h = await hashOf(c, r.pin);
  return c.deps.tx(c.userId, async (t) => ((await t.insertVault(h)) ? out({}, 0) : err(409, 'already_set')));
}

/** {unlock, pin} */
export function unlock(c: Ctx, r: ReqOf<'unlock'>): Promise<Out | Response> {
  return c.deps.tx(c.userId, async (t) => {
    const row = await t.vault(true);
    if (!row) return err(409, 'not_set');
    const bad = await checkPin(c, t, row, r.pin);
    return bad ?? out({}, row.pin_epoch);
  });
}

/** 换密码的共同收尾：新哈希、清失败计数、pin_epoch + 1、删凭据和设备盐（change_pin、reset） */
async function rekey(t: VaultTx, row: VaultRow, hash: string, extra: { last_reset_at?: number } = {}): Promise<number> {
  const epoch = row.pin_epoch + 1;
  await t.updateVault({ pin_hash: hash, pin_epoch: epoch, fail_count: 0, lock_level: 0, locked_until: null, ...extra });
  await t.dropCredentialsAndSecrets();
  return epoch;
}

/**
 * {change_pin, old_pin, new_pin}：要有效令牌；row 是 core.ts 验令牌时 for update 读的那一行（整块评审第 13 条：验和改用同一行，中间不会被并发改密码插进来）。
 * 旧密码输错和 unlock 共用计数
 */
export async function changePin(c: Ctx, t: VaultTx, r: ReqOf<'change_pin'>, row: VaultRow): Promise<Out | Response> {
  if (!c.deps.rules.pinRe.test(r.new_pin)) return err(400, 'bad_pin');
  const bad = await checkPin(c, t, row, r.old_pin);
  if (bad) return bad;
  const epoch = await rekey(t, row, await hashOf(c, r.new_pin));
  notifyLater(c, 'pin_changed');
  return out({}, epoch);
}

/** {reset, new_pin}：10 分钟内刚用邮箱验证码登录过；立即生效 */
export async function reset(c: Ctx, r: ReqOf<'reset'>): Promise<Out | Response> {
  const { deps } = c;
  if (!otpFresh(c.jwt, deps.now(), deps.rules.resetOtpMaxAgeS)) return err(401, 'reauth_required');
  if (!deps.rules.pinRe.test(r.new_pin)) return err(400, 'bad_pin');
  const h = await hashOf(c, r.new_pin);
  const at = deps.now();
  const res = await deps.tx(c.userId, async (t) => {
    const row = await t.vault(true);
    if (!row) return err(409, 'not_set');
    return out({}, await rekey(t, row, h, { last_reset_at: at }));
  });
  if (res instanceof Response) return res;
  notifyLater(c, 'reset');
  deps.background(deps.resetMail(c.userId, at).catch(() => deps.log('mail_failed:vault_reset')));
  deps.background(deps.insertLog(c.userId, { t: at, act: 'vault_reset' }).catch(() => deps.log('log_failed:vault_reset')));
  return res;
}
