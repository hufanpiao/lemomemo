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
  email, err, Fail, json, keys, locale, otpHash, readBody, secureOtp, signupMail, str, type StartBody, type VerifyBody,
} from './wire.ts';

export type {
  AuthAdmin, CreateUserResult, Deps, Env, InviteErr, InviteRow, Locale, PendingRow, Store, TurnstileResult,
} from './types.ts';
export { keys, otpHash, secureOtp, signupMail, utcDate } from './wire.ts';

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
  if (!inviteUsable(inv, now)) return ok;

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

function inviteUsable(inv: InviteRow | null, now: number): inv is InviteRow & { max_uses: number; used_count: number; expires_at: string } {
  if (!inv || inv.max_uses === null || inv.used_count === null || inv.expires_at === null) return false;
  const exp = Date.parse(inv.expires_at);
  return Number.isFinite(exp) && exp > now && inv.used_count < inv.max_uses;
}

// ---------------- verify ----------------
/** 原子占用邀请码：比较并交换，被别人抢先就重读再试（最多重试 3 次，0.38 第 19 条）；用完、过期、不存在都回 false */
async function claimInvite(store: Store, codeHash: string, now: number): Promise<boolean> {
  for (let i = 0; i < CAS_ATTEMPTS; i++) {
    const inv = await store.getInvite(codeHash);
    if (!inviteUsable(inv, now)) return false;
    if (await store.casInviteUsed(codeHash, inv.used_count, inv.used_count + 1, new Date(now).toISOString())) return true;
  }
  return false;
}

/**
 * 退回邀请码（used_count > 0 才减；尽力而为，失败只记错误码）。
 * 已知会丢码的两种情况（K2 安全审查低 7，有意接受，码由负责人重发）：
 *   ① 比较并交换连续冲突超过重试次数（同一个码同时有多人在注册，极少见），记 release_conflict；
 *   ② 函数在占码之后、退码之前超时或被平台杀掉，退码这一步根本没跑，码就一直算“用过一次”。
 *   ③ 占码那一下 casInviteUsed 超时（INVITE-store-timeout，10 秒）而语句晚到提交：函数已经回了 try_later、不会去退，
 *      码却算“用过一次”；不能超时就退（不知道到底提交没有，退了可能多出一次）。
 */
async function releaseInvite(deps: Deps, codeHash: string): Promise<void> {
  try {
    for (let i = 0; i < CAS_ATTEMPTS; i++) {
      const inv = await deps.store.getInvite(codeHash);
      if (!inv || inv.used_count === null || inv.used_count <= 0) return;
      if (await deps.store.casInviteUsed(codeHash, inv.used_count, inv.used_count - 1, null)) return;
    }
    deps.log?.('release_conflict');
  } catch {
    deps.log?.('release_failed');
  }
}

/**
 * 验邮箱验证码：先占一次尝试（比较并交换 tries，条件带 otp_hash），再比哈希。
 * 防探测（K2 安全审查 P1、第二轮复审 Q1）：没有待验证记录和填错回同一个 400 code_wrong；
 *   记录已过期（每日清理前一直在）时，不占尝试次数，先比对这次填的：填对才回 410 code_expired，填错回 code_wrong，
 *   两种都删掉这一行——没拿到验证码的人看不出这个邮箱有没有过期的注册。
 *   试满 5 次回 too_many_tries 能试出“有正在进行的注册”，架构 0.38 第 39 条已接受（客户端靠它回第一步），不改。
 */
async function checkOtp(deps: Deps, secret: string, eh: string, codeHash: string, otp: string): Promise<void> {
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
    if (await matches(p)) return;
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
  await checkOtp(deps, secret, eh, codeHash, b.otp);

  // 验证码对了（码和 start 时是同一个），才占用邀请码
  if (!(await claimInvite(store, codeHash, deps.now()))) throw new Fail(400, 'invite_invalid');

  // 建用户（不设密码）；失败退回邀请码
  let created: CreateUserResult;
  try {
    created = await auth.createUser(b.email, b.locale);
  } catch {
    created = { ok: false, exists: false };
  }
  if (!created.ok) {
    await releaseInvite(deps, codeHash);
    if (created.exists) {
      // 邮箱已存在：先退回邀请码，再回 email_exists，不调 generateLink（第二轮安全 N8）
      await store.deletePending(eh).catch(() => log?.('pending_delete_failed'));
      throw new Fail(409, 'email_exists');
    }
    log?.('create_user_failed');
    throw new Fail(503, 'try_later');
  }

  // 建 profiles；失败删掉刚建的用户（没有 profile 的账号本来也用不了），删成了才退回邀请码
  try {
    await store.insertProfile(created.userId, b.locale);
  } catch {
    log?.('profile_failed');
    let deleted = true;
    await auth.deleteUser(created.userId).catch(() => { deleted = false; });
    if (deleted) {
      await releaseInvite(deps, codeHash);
    } else {
      // K2 安全审查 P5：删不掉就不退码（码退回了，人却留下一个没有 profile 的账号，重试只会得到 email_exists）。
      // orphan_user 要告警：负责人到控制台按 user_id 前 8 位找到这个账号删掉、重发邀请码（日志只记前 8 位，0.38）
      log?.(`orphan_user:${created.userId.slice(0, 8)}`);
    }
    throw new Fail(503, 'try_later');
  }

  // 注册成功即删 pending_signups（0.29 续第 48 条）；删失败不影响注册，过期由每日清理删
  await store.deletePending(eh).catch(() => log?.('pending_delete_failed'));

  // 只对这一步刚建出来的用户签发 magiclink（5.6）
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
