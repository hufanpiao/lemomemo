// invite-signup 的处理逻辑（架构 5.6、第 6 节函数表、15.2 中 1 ④、15.3 第 8 条、附录 A counters 键表、0.38 第 19、20 条；
// TC-B1-02～05、TC-B1-64）。数据库、Auth 管理接口、Turnstile、发信都由 index.ts 注入，Vitest 直接测这一份。
// 类型在 types.ts，回包、请求体、邮件、哈希小工具在 wire.ts（B1 第九批 lint 超行拆分）；对外的名字一律还从这里引。
// 以后再拆也不能挪走的：handle、start、verify，以及版本门 blockedMin 的 import 和调用，都必须留在本文件——
// tests/build/fn-version-gate-coverage.test.ts 只扫 core.ts（看 handle 开头、blockedMin 的引入和调用），挪走就判成没接版本门。
// 拆出去的文件只放类型和不带流程的纯工具。
// 不 import npm 包、不碰运行时全局（只用 Web 标准的 crypto、TextEncoder、Request、Response）。
//
// 两步（匿名调用；JWT 只是 anon key，不当身份）：
//   start  {step, email, code, captchaToken, locale}：Turnstile（没带令牌 400；success、hostname、action = invite_start 有一样不对 403）→ 版本门
//          → 限流（IP、邮箱）→ 校验邀请码（不占用）→ 码有效才过全站每天 50 封这一道（只数真正要发的信，K2 安全审查 P4）
//          → 生成 6 位邮箱验证码（只存哈希，和邀请码绑定，10 分钟，最多试 5 次）并发信。
//          过了 Turnstile 以后一律回 {ok: true}：码错、被限流、发信失败都一样，看不出区别（5.6、TC-B1-02、TC-B1-64）。
//   verify {step, email, code, email_otp[, locale]}：按 IP 限流（每小时 30 次，K2 安全审查 P1）→ 版本门 → 验证码
//          （“没有待验证记录”、“填错”、“过期了又填错”回同一个 400 code_wrong，探不出谁在注册）→ 原子占用邀请码 → createUser（不设密码）
//          → 建 profiles → 删 pending_signups → generateLink(magiclink) 回 {token_hash}；中途失败把邀请码退回（第二轮安全 N8）。
// 日志只记错误码（A23）：不打印请求头、请求体、邮箱、验证码、邀请码、IP。
// 从来不返回邀请人信息（R-83、TC-B1-05）：invites 只读 max_uses、used_count、expires_at 三列。

import { emailHash, ipHash } from '../_shared/email-hash.ts';
import { inviteCodeHash, isInviteCode, normalizeInviteCode } from '../_shared/invite-code.ts';
import { rateIp, readProxyHeaders, safeEqual } from '../_shared/proxy-headers.ts';
import { StoreTimeout } from '../_shared/store-timeout.ts';
import { blockedMin, upgradeRequiredResponse } from '../_shared/version-gate-core.ts';
import type { CreateUserResult, Deps, Env, InviteRow, PendingRow, Store, TurnstileResult } from './types.ts';
import {
  email, err, Fail, json, keys, locale, otpHash, readBody, secureOtp, signupMail, signupUserId, str, type StartBody, type VerifyBody,
} from './wire.ts';

export type {
  AuthAdmin, ClaimResult, CreateUserResult, Deps, Env, InviteErr, InviteRow, Locale, PendingRow, Store, TurnstileResult,
} from './types.ts';
export { keys, otpHash, secureOtp, signupMail, signupUserId, utcDate } from './wire.ts';

// ---------------- 常量（出处见行尾） ----------------
export const OTP_TTL_S = 600;             // 10 分钟（5.6）
export const OTP_MAX_TRIES = 5;           // 最多试 5 次（5.6、TC-B1-64 ④）
export const LIMIT_IP_PER_HOUR = 10;      // start：同一 IP 每小时 10 次（5.6、第 6 节）
export const LIMIT_MAIL_PER_HOUR = 5;     // start：同一邮箱每小时 5 次
export const LIMIT_GLOBAL_PER_DAY = 50;   // 全站每天 50 封（15.3 第 8 条；K2 安全审查 P4 起只数真正要发的信）
export const LIMIT_VERIFY_IP_PER_HOUR = 30;   // verify：同一 IP 每小时 30 次（K2 安全审查 P1；键 signup-verify:ip:<HMAC>，由架构登记进附录 A）
const HOUR_S = 3600;
const DAY_S = 86400;
/** 比较并交换的尝试次数：首次 + 最多重试 3 次（架构 0.38 第 19 条） */
const CAS_ATTEMPTS = 4;
/** 不可信来源（没经转发层、或 x-proxy-secret 不对）的请求共用一个 IP 桶：伪造的 x-client-ip 换不出新额度（TC-B1-64 ⑤、TC-B0-91） */
export const UNTRUSTED_IP_BUCKET = 'untrusted';
/** Turnstile 的 action：start 一步是 invite_start（架构 0.38 第 25～32 条；前端 useTurnstile 同一个值） */
export const TURNSTILE_ACTION = 'invite_start';
/** siteverify 返回的 hostname 只认这些（5.6：Redirect URLs、Site URL 同一个域名；本机调试认 localhost、127.0.0.1） */
export const TURNSTILE_HOSTS: Readonly<Record<Env, readonly string[]>> = {
  prod: ['lemomemo.com'],
  preview: ['preview.lemomemo.com'],
  local: ['localhost', '127.0.0.1'],
};

/** IP 计数键的第三段：可信来源按 rateIp 规范化（IPv6 只取 /64、::ffff:a.b.c.d 当 IPv4）后取 HMAC；其余进共用桶 */
async function ipPart(req: Request, deps: Deps, secret: string): Promise<{ part: string; trustedIp: string | null }> {
  const proxy = readProxyHeaders(req, deps.proxySecret);
  const r = proxy.trusted && proxy.ip ? rateIp(proxy.ip) : null;
  return r ? { part: await ipHash(secret, r), trustedIp: proxy.ip } : { part: UNTRUSTED_IP_BUCKET, trustedIp: null };
}

// ---------------- 版本门（第 6 节：函数里的第二道；口径同 functions/sb/version-gate.ts，比较用 _shared/version-gate-core.ts） ----------------
// store.minClientVersion 由 index.ts 经 cachedMinClientVersion 注入（0.38 第 52 条：超时 1.5 秒、缓存，读失败返回 null = 放行）
async function versionBlock(req: Request, store: Store): Promise<Response | null> {
  let min: string | null;
  try {
    min = await store.minClientVersion();
  } catch {
    return null;   // 读配置失败就放行，不因为配置出错把人挡在外面（同转发层）
  }
  const b = blockedMin(min, req.headers.get('x-app-version'));
  return b === null ? null : upgradeRequiredResponse(b);
}

// ---------------- start ----------------
async function start(req: Request, b: StartBody, deps: Deps, secret: string): Promise<Response> {
  const { store, log } = deps;
  const ip = await ipPart(req, deps, secret);

  // ① Turnstile（不过就拒绝；没带令牌、hostname 或 action 对不上都一样）
  if (!b.captchaToken) return err(400, 'captcha_failed');
  let t: TurnstileResult;
  try {
    t = await deps.verifyTurnstile(b.captchaToken, ip.trustedIp);
  } catch {
    log?.('turnstile_unreachable');
    return err(503, 'try_later');
  }
  if (t.success !== true || t.hostname === null || !TURNSTILE_HOSTS[deps.env].includes(t.hostname) || t.action !== TURNSTILE_ACTION) {
    if (t.success === true) log?.('turnstile_mismatch');
    return err(403, 'captcha_failed');
  }

  // ② 版本门放在 Turnstile 之后（K2 安全审查低 6：没过人机校验的请求不读配置）
  const blocked = await versionBlock(req, store);
  if (blocked) return blocked;

  const ok = json(200, { ok: true });
  const now = deps.now();
  const eh = await emailHash(secret, b.email);

  // ③ 限流：IP → 邮箱，前一道不过就不再往下计；超了照样回 {ok}、不发信
  if (!(await store.takeRate(keys.ip(ip.part), LIMIT_IP_PER_HOUR, HOUR_S))) { log?.('rate_ip'); return ok; }
  if (!(await store.takeRate(keys.mail(eh), LIMIT_MAIL_PER_HOUR, HOUR_S))) { log?.('rate_mail'); return ok; }

  // ④ 邀请码：只看有没有效，不占用
  if (!isInviteCode(b.code)) return ok;
  const codeHash = await inviteCodeHash(b.code);
  const inv = await store.getInvite(codeHash);
  if (!inviteUsable(inv, now) && !(await claimedByThisEmail(store, eh, codeHash, inv, now))) return ok;

  // ⑤ 全站每天 50 封：只数真正要发的信（K2 安全审查 P4：错码刷不掉全站额度）。码无效时不到这一步，回的同样是 {ok}，不泄露码对不对。
  //    这一道在发信之前计数，发信失败的那一封也算（宁可少发，不多发）
  // ⑤⑥ 出错或超时（INVITE-store-timeout）也回 {ok}、不发信：到这里已经知道码有效，回 try_later 就等于告诉对方“码是对的”。
  //    只记 db_error（超时由 store-timeout 记 store_timeout:<方法名>）；用户收不到信，过一会儿重新点发送即可
  const otp = String((deps.randomOtp ?? secureOtp)()).padStart(6, '0');
  try {
    if (!(await store.takeRate(keys.global(now), LIMIT_GLOBAL_PER_DAY, DAY_S))) { log?.('rate_global'); return ok; }
    // ⑥ 生成验证码（只存哈希，和邀请码绑定）并发信
    await store.putPending(eh, {
      otp_hash: await otpHash(secret, eh, codeHash, otp),
      tries: 0,
      expires_at: new Date(now + OTP_TTL_S * 1000).toISOString(),
    });
  } catch (e) {
    if (!(e instanceof StoreTimeout)) log?.('db_error');
    return ok;
  }
  const sent = await deps.sendMail(b.email, signupMail(b.locale, otp)).catch(() => false);
  if (!sent) log?.('mail_failed');
  return ok;
}

/**
 * 码已占满，但占着它的正是这个邮箱（pending.claimed_code 就是这个码，INVITE-late-commit 安全建议 1）：当作可用、照常重发验证码，
 * verify 时 invite_claim 回 reused 沿用这次占用。只在码存在、没过期、已占满时才多读这一次 pending；读出错或超时一律按“不是”，回 {ok}，
 * 和码无效时一样，不泄露码有没有效。
 * 已知取舍（安全审查增量复核）：码已占满时比码不存在多一次读库，本邮箱占着时还多走计数、写 pending、发信；这些时延差能让同时知道码和邮箱的人
 * 确认“这个用满的码存在、该邮箱在用它注册”。一次性码只有受邀人和负责人知道，用满的码对外无用，start 本来就有码有效/无效的时延差，故不改
 */
async function claimedByThisEmail(store: Store, eh: string, codeHash: string, inv: InviteRow | null, now: number): Promise<boolean> {
  if (!inv || inv.expires_at === null || !(Date.parse(inv.expires_at) > now)) return false;
  try {
    return (await store.getPending(eh))?.claimed_code === codeHash;
  } catch {
    return false;
  }
}

function inviteUsable(inv: InviteRow | null, now: number): inv is InviteRow & { max_uses: number; used_count: number; expires_at: string } {
  if (!inv || inv.max_uses === null || inv.used_count === null || inv.expires_at === null) return false;
  const exp = Date.parse(inv.expires_at);
  return Number.isFinite(exp) && exp > now && inv.used_count < inv.max_uses;
}

// ---------------- verify ----------------
/**
 * 退回邀请码（private.invite_release：只退这个邮箱 pending 上记着占了的这个码；尽力而为，失败只记错误码）。
 * 占码、退码都跟 pending 行的 claimed_code 在同一个事务里（迁移 20261031150000，INVITE-late-commit）：
 *   占码超时晚到提交，重试 verify 时沿用、不再占；退码晚到提交、重复调用都不会多退。
 * 已知会丢码（有意接受，码由负责人重发）：占上之后用户一直不再验证，pending 过期被每日清理删掉（迁移文件头）。
 */
async function releaseInvite(deps: Deps, eh: string, codeHash: string): Promise<void> {
  try {
    await deps.store.releaseInvite(eh, codeHash);
  } catch {
    deps.log?.('release_failed');
  }
}

/**
 * 建用户（INVITE-auth-timeout）。id 由邮箱哈希 + 邀请码哈希派生（signupUserId，不跟验证码版本走），所以：
 *   成功回用户 id；createUser 超时、或回“已存在”时，按 id 查一次：查得到就是同一邮箱、同一个码建的（这一次，或上一次超时晚到——
 *   含重新发码后用新验证码再验），接着用；同一个多次码再注册撞上已注册完的账号也会查到，由 verify 按 profile 已有判 email_exists；
 *   超时而查不到、查失败：不知道会不会晚到建出来，回 unknown（不退码、不删，客户端 try_later，重试时同一个 id 再建或认领）；
 *   回“已存在”而 id 查不到：邮箱是别人早就注册的，回 exists。
 * 超时、查不到、查失败三种回包都一样是 try_later，看不出邮箱在不在。
 * 成功时 fresh 表示是不是这一次 createUser 刚建出来的：按 id 认领来的用户（安全审查 N1）可能是已经在用的真实账号——
 *   第一次 verify 全成功后又来一次，或两次 verify 并发——调用方对它不删；profile 已有时按 email_exists 处理。
 * Auth 管理接口的超时中止不了底下的请求（store-timeout.ts 的 withAuthTimeouts），createUser、deleteUser 都可能晚到做成；
 *   有了 fresh 这一分，deleteUser 只会删到这一次刚建出来、还没补上 profile 的半成品。
 */
async function createOrAdopt(deps: Deps, uid: string, b: VerifyBody): Promise<{ id: string; fresh: boolean } | 'exists' | 'failed' | 'unknown'> {
  let r: CreateUserResult | 'timeout';
  try {
    r = await deps.auth.createUser(uid, b.email, b.locale);
  } catch (e) {
    r = e instanceof StoreTimeout ? 'timeout' : { ok: false, exists: false };
  }
  if (r !== 'timeout' && r.ok) {
    if (r.userId !== uid) deps.log?.('user_id_mismatch');   // Auth 没按给的 id 建（不该发生）：照用它回的 id，只是超时认领不再灵
    return { id: r.userId, fresh: true };
  }
  if (r !== 'timeout' && !r.exists) return 'failed';
  const mine = await deps.auth.userExists(uid).catch(() => null);
  if (mine === true) return { id: uid, fresh: false };
  return r === 'timeout' || mine === null ? 'unknown' : 'exists';
}

/**
 * 验邮箱验证码：先占一次尝试（比较并交换 tries，条件带 otp_hash），再比哈希。
 * 防探测（K2 安全审查 P1、第二轮复审 Q1）：没有待验证记录和填错回同一个 400 code_wrong；
 *   记录已过期（每日清理前一直在）时，不占尝试次数，先比对这次填的：填对才回 410 code_expired，填错回 code_wrong，
 *   两种都删掉这一行——没拿到验证码的人看不出这个邮箱有没有过期的注册。
 *   试满 5 次回 too_many_tries 能试出“有正在进行的注册”，架构 0.38 第 39 条已接受（客户端靠它回第一步），不改。
 */
async function checkOtp(deps: Deps, secret: string, eh: string, codeHash: string, otp: string): Promise<string> {
  const { store } = deps;
  const now = deps.now();
  const matches = async (p: PendingRow) => /^\d{6}$/.test(otp) && safeEqual(await otpHash(secret, eh, codeHash, otp), p.otp_hash);
  for (let i = 0; i < CAS_ATTEMPTS; i++) {
    const p = await store.getPending(eh);
    if (!p) throw new Fail(400, 'code_wrong');
    const exp = Date.parse(p.expires_at);
    if (!Number.isFinite(exp) || exp <= now) {
      const good = await matches(p);
      await store.deletePending(eh, p.otp_hash);
      throw good ?new Fail(410, 'code_expired') : new Fail(400, 'code_wrong');
    }
    if (p.tries >= OTP_MAX_TRIES) {
      // 第 6 次起即使填对也作废，要重新开始（TC-B1-64 ④）
      await store.deletePending(eh, p.otp_hash);
      throw new Fail(400, 'too_many_tries');
    }
    if (!(await store.casPendingTries(eh, p.tries, p.tries + 1, p.otp_hash))) continue;   // 并发的另一次先占了，或刚重新发了码：重读
    if (await matches(p)) return p.otp_hash;
    throw new Fail(400, p.tries + 1 >= OTP_MAX_TRIES ? 'too_many_tries' : 'code_wrong');
  }
  throw new Fail(503, 'try_later');
}

async function verify(req: Request, b: VerifyBody, deps: Deps, secret: string): Promise<Response> {
  const { store, auth, log } = deps;

  // 按 IP 限流（K2 安全审查 P1）：在读 pending 之前，被限流的请求不消耗任何人的尝试次数
  const ip = await ipPart(req, deps, secret);
  if (!(await store.takeRate(keys.verifyIp(ip.part), LIMIT_VERIFY_IP_PER_HOUR, HOUR_S))) {
    log?.('rate_verify_ip');
    throw new Fail(429, 'rate_limited');
  }

  // 版本门放在限流之后（第二轮复审：和 start 一样，先挡刷的，再读配置）
  const blocked = await versionBlock(req, store);
  if (blocked) return blocked;

  const eh = await emailHash(secret, b.email);
  const codeHash = await inviteCodeHash(b.code);   // 格式不对也照样算：验证码和码绑定，对不上就是 code_wrong
  const oh = await checkOtp(deps, secret, eh, codeHash, b.otp);

  // 验证码对了（码和 start 时是同一个），才占用邀请码（private.invite_claim：同一版 pending 已占过就沿用，不再占）
  const claim = await store.claimInvite(eh, oh, codeHash, new Date(deps.now()).toISOString());
  if (claim === 'no_pending') throw new Fail(400, 'code_wrong');   // 验完到占码之间重新发了码：这一版验证码已经作废
  if (claim !== 'ok' && claim !== 'reused') throw new Fail(400, 'invite_invalid');

  // 建用户（不设密码；id 由邮箱哈希 + 邀请码哈希派生，见 createOrAdopt）
  const uid = await signupUserId(secret, eh, codeHash);
  const created = await createOrAdopt(deps, uid, b);   // 成功时是 {id, fresh}
  if (created === 'exists' && claim === 'reused') {
    // 代码审查 ②：这个邮箱之前已经占过码，“已存在”的可能是这个邮箱之前用**别的码**时 createUser 超时晚到建出的用户
    // （id 按邮箱 + 码派生，同一个码重新发码后仍认得出；换了码就认不出——orphan_suspect 只剩这一种，代码审查增量复核 1）。
    // 不能断定是别人的账号：不退码、不回 email_exists，回 try_later；记 orphan_suspect（日志不带邮箱、id）。
    // 这个邮箱之后每次 verify 都会这样一直 try_later，直到 pending 过期（10 分钟）被删、码也不退——要负责人看到日志后按下面的办法核对、手工处理。
    // 负责人核对办法（orphan_user 同一个办法；两种孤儿都是“auth 里有用户、profiles 里没有行”）：
    //   ① Supabase 控制台 → Edge Functions → invite-signup → Logs，搜 orphan_（记下时刻）；
    //   ② SQL Editor 跑：select u.id, u.email, u.created_at from auth.users u left join public.profiles p on p.user_id = u.id
    //        where p.user_id is null and u.created_at < now() - interval '10 minutes' order by u.created_at desc;
    //      创建时刻和日志时刻对得上的那一行就是（orphan_user 再对 id 前 8 位）；
    //   ③ 控制台 Authentication → Users 删掉这个用户（没有 profile，没有任何业务数据），用 invite-admin 给这个邮箱的人重发一个新邀请码；
    //      旧码不必退（一次性码，已占的那一次作废）。
    //   ②查不到这个邮箱的行：是“注册成功但删 pending 失败、又换码再验”那种（迁移 20261031150000 文件头），撞上的是一个正常账号——
    //      不要删用户，告诉对方直接用邮箱验证码登录；那行 pending 等过期（每日清理）或在 SQL Editor 手工删掉即可。
    log?.('orphan_suspect');
    throw new Fail(503, 'try_later');
  }
  if (created === 'exists') {
    // 邮箱已存在：先退回邀请码，再回 email_exists，不调 generateLink（第二轮安全 N8）
    await releaseInvite(deps, eh, codeHash);
    await store.deletePending(eh).catch(() => log?.('pending_delete_failed'));
    throw new Fail(409, 'email_exists');
  }
  if (created === 'unknown') {
    // 可能晚到建出来：码不退、用户不删，重试时沿用占码、按同一个 id 认领
    log?.('create_user_unknown');
    throw new Fail(503, 'try_later');
  }
  if (created === 'failed') {
    await releaseInvite(deps, eh, codeHash);
    log?.('create_user_failed');
    throw new Fail(503, 'try_later');
  }

  // 建 profiles（已有就不动）
  let inserted: boolean;
  try {
    inserted = await store.insertProfile(created.id, b.locale);
  } catch {
    log?.('profile_failed');
    // 安全审查 N1：按 id 认领来的用户可能已经在用，不删、不退码，只回 try_later（重试再补）
    if (!created.fresh) throw new Fail(503, 'try_later');
    // 这一次刚建出来的：删掉（没有 profile 的账号本来也用不了），删成了才退回邀请码
    let deleted = true;
    await auth.deleteUser(created.id).catch(() => { deleted = false; });
    if (deleted) {
      await releaseInvite(deps, eh, codeHash);
    } else {
      // K2 安全审查 P5：删不掉（含超时；超时的 deleteUser 也可能晚到删成，删的只会是这个半成品）就不退码。
      // 重试 verify 时沿用占码、按同一个 id 认领这个用户再补 profile；
      // 用户一直不重试才成孤儿：记 orphan_user（只记 user_id 前 8 位，0.38），负责人按上面 orphan_suspect 那段的办法核对、删掉、重发邀请码
      log?.(`orphan_user:${created.id.slice(0, 8)}`);
    }
    throw new Fail(503, 'try_later');
  }
  if (!inserted && !created.fresh) {
    // 认领来的用户 profile 早就有：是注册完的账号（同一邮箱用同一个多次码再注册——线上只有一次性码，只在负责人手工建多次码时会有；
    // 或上一次全成功后又来一次），按邮箱已存在处理：
    // 这次新占的（claim = ok）退回；reused 那一次属于当初那次成功的注册，不退。不签 magiclink，客户端引导去登录。
    // 还有一种（代码审查发现）：第一次 verify 时 insertProfile 超时但晚到提交（认领来的没被删，或 fresh 但 deleteUser 失败），
    // 下一次 verify 认领后发现 profile 已有 → 也回 409：这时账号完整可用（用户改走邮箱验证码登录即可），码按 reused 不退
    if (claim === 'ok') await releaseInvite(deps, eh, codeHash);
    await store.deletePending(eh).catch(() => log?.('pending_delete_failed'));
    throw new Fail(409, 'email_exists');
  }

  // 注册成功即删 pending_signups（0.29 续第 48 条）；删失败不影响注册，过期由每日清理删
  await store.deletePending(eh).catch(() => log?.('pending_delete_failed'));

  // 给这次验证通过的邮箱对应的账号签发 magiclink（5.6）：通常是这一步刚建出来的用户；
  // 也可能是按派生 id 认领来的、同一邮箱同一个码上一次超时晚到建出、还没有 profile 的用户——
  // 能走到这里的人已经验过这个邮箱的验证码，签给他自己的账号，和走“发登录验证码”登录等价
  const tokenHash = await auth.magiclinkTokenHash(b.email).catch(() => null);
  if (!tokenHash) {
    // 账号已经建好，邀请码已占用：客户端改走普通的“发登录验证码”登录（5.6 的退路）
    log?.('link_failed');
    return err(502, 'link_failed');
  }
  return json(200, { token_hash: tokenHash });
}

// ---------------- 入口 ----------------
export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return err(405, 'method_not_allowed');
  const secret = deps.hashSecret;
  if (!secret || !deps.configured) {
    deps.log?.('misconfigured');
    return err(500, 'misconfigured');
  }
  if (!deps.proxySecret) {
    // 正式环境没配 PROXY_SECRET：所有人都进“不可信”那一个 IP 桶，十个人就能把注册堵死，宁可明确报错（K2 安全审查低 3）
    if (deps.env === 'prod') {
      deps.log?.('misconfigured');
      return err(500, 'misconfigured');
    }
    deps.log?.('proxy_secret_missing');
  }

  const body = await readBody(req);
  if (!body) return err(400, 'bad_request');
  const em = email(body.email);
  const code = str(body.code, 64);
  if (!em || code === null) return err(400, 'bad_request');
  const normCode = normalizeInviteCode(code);

  try {
    if (body.step === 'start') {
      const token = body.captchaToken === undefined ? '' : str(body.captchaToken, 4096);
      if (token === null) return err(400, 'bad_request');
      return await start(req, { email: em, code: normCode, captchaToken: token, locale: locale(body.locale) }, deps, secret);
    }
    if (body.step === 'verify') {
      const otp = str(body.email_otp, 32);
      if (otp === null) return err(400, 'bad_request');
      return await verify(req, { email: em, code: normCode, otp: otp.replace(/\s/g, ''), locale: locale(body.locale) }, deps, secret);
    }
    return err(400, 'bad_request');
  } catch (e) {
    if (e instanceof Fail) return err(e.status, e.code);
    // 错误对象可能带连接信息、SQL，不打印；超时在 store-timeout 已记 store_timeout:<方法名>，不再记 db_error
    if (!(e instanceof StoreTimeout)) deps.log?.('db_error');
    return err(503, 'try_later');
  }
}
