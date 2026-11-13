// account {action: 'rebind_device'}：重新验证邮箱后把这台设备的 devices 行交接给新会话（架构 0.29 续第 104、112、113、119 条，0.39 第 2 条；
// B5 任务单 S3、代定 D9；TC-B1-84、85 ①～⑤ ⑩、86、93；接手清单 K-rebind-active）。
// 正文 {action, device_id, old_token}：Authorization 是新会话 S2，old_token 是这台设备原来那个会话 S1 的 access token。
// 顺序：自己查版本（account 整个 POST 免查，但这个动作写 devices 同步表，低版本回 426，D9）→ 正文 → S2 过 requireActiveUser
//   → S2 的 amr 里 otp 在 10 分钟内（否则 401 reauth_required）→ 每人每天 10 次（rebind:<uid>:<UTC 日期>，失败的也算）
//   → 这台设备行已经挂在 S2 上（上次交接其实成功了、客户端没拿到响应又发一次，11-14 独立评审 M5）：直接回成功，什么都不改
//   → S1 也过 requireActiveUser（签名、没过期、会话活着、账号可用），两个是同一个人、不是同一个会话
//   → service role 经 PostgREST 的 rpc 调 private.rebind_device_impl（第 119 条①：直连数据库时 role 是 none，交接一律失败，不许放宽）。
// S1 验不过、不是同一个人、rpc 拒绝（session_mismatch、device_mismatch、session_in_use、session_revoked、rebind_denied、bad_rebind 等）
//   一律 409 rebind_failed，不分原因、不透传 session_revoked（免得客户端当成本机被移除去清库；客户端收到就丢掉 S2、继续用 S1）。
// old_token 只放进一个临时 Request 的 Authorization 头交给 authenticate，不进日志、不进 logs 表、不进错误响应（第 113 条②、A23）。
import { otpFresh } from '../_shared/otp-fresh.ts';
import { DAY_S, DbError, type Deps, err, json, keys } from './common.ts';

export const REBIND_DAILY_LIMIT = 10;          // 0.29 续第 113 条①
export const REBIND_OTP_MAX_AGE_S = 600;       // 0.29 续第 104 条③：S2 的 otp 在 10 分钟以内
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_MAX = 4096;

export async function rebindDevice(req: Request, body: Record<string, unknown>, deps: Deps): Promise<Response> {
  const blocked = await deps.checkVersion(req);
  if (blocked) return blocked;
  const deviceId = body.device_id;
  const oldToken = body.old_token;
  if (typeof deviceId !== 'string' || !UUID.test(deviceId) || typeof oldToken !== 'string' || oldToken.length < 16 || oldToken.length > TOKEN_MAX) {
    return err(400, 'bad_request');
  }
  const auth = await deps.authenticate(req, { allowPendingDeletion: false });
  if (!auth.ok) return auth.response;
  const user = auth.user;
  if (!otpFresh(user.jwt, deps.now(), REBIND_OTP_MAX_AGE_S)) return err(401, 'reauth_required');
  if (!(await deps.store.takeRate(keys.rebind(user.userId, deps.now()), REBIND_DAILY_LIMIT, DAY_S))) return err(429, 'rate_limited');
  // 重入：S1 这时已被上次的交接吊销，再验 S1 必然不过；行已经是 S2 的就算成功（只认调用者自己这个已验过的新会话，不改任何东西）
  if ((await deps.store.deviceSession(user.userId, deviceId)) === user.sessionId) return json(200, { ok: true });

  const old = await deps.authenticate(new Request(req.url, { method: 'POST', headers: { authorization: `Bearer ${oldToken}` } }), { allowPendingDeletion: false });
  if (!old.ok) return old.code === 'try_later' ? err(503, 'try_later') : err(409, 'rebind_failed');
  if (old.user.userId !== user.userId || old.user.sessionId === user.sessionId) return err(409, 'rebind_failed');
  try {
    await deps.store.rebindDevice(user.userId, deviceId, old.user.sessionId, user.sessionId);
  } catch (e) {
    if (e instanceof DbError) return err(409, 'rebind_failed');
    throw e;
  }
  return json(200, { ok: true });
}
