// 本机推送替身对每个请求做的检查（push-service.ts 的 serve 用）：
//   ① 请求体超过 maxBodyBytes（默认 4096，推送服务的上限）回 413，不管开没开 VAPID
//   ② 给了 subscribers 时解负载，记下是哪个订阅方、明文是什么（请求路径等于某个订阅方 endpoint 的路径时先试它，省得 300 个订阅方挨个试）
//   ③ 开了 VAPID 时按推送服务的做法核：Authorization、aud（绑定本次请求的源，代码审查 M1）、TTL、Content-Encoding: aes128gcm、
//      Content-Type: application/octet-stream、aes128gcm 的头（idlen、rs、单条记录）、给了 subscribers 却谁都解不开
//   ④ 端口模式（请求地址是替身自己）下 aud 只能按订阅方的 endpoint 绑：解开负载的订阅方没带 endpoint、或没配订阅方时
//      记 aud_unbound、回 403，不再退回“四家推送服务之一就放行”（复核 N3）；配了订阅方却谁都没解开记 decrypt_failed、回 400
// 造数据注意（复核 N1）：端口模式下路径都是 /push，每个请求要把订阅方挨个试解一遍（试一个约一次 ECDH + 三次 HKDF）。
//   压测类用例按“少量设备、每台多条”造：例如每人每分钟最多 20 条，300 条约 15 台设备；不要 300 条配 300 个订阅方，
//   否则试解是 O(条数 × 设备数)，会把 TC-B2-81 的 25 秒计时拖慢
import type { Incoming } from './push-service-port.ts';
import { type FakeVapidOptions, type PushReply, type PushRequestRecord, reply } from './push-service-types.ts';
import { type Aes128gcmBody, checkVapid, decryptRecord, parseAes128gcm, type PushSubscriber, type VapidResult } from './push-service-vapid.ts';

/** 四家推送服务的源（架构审 D1 的主机白名单）；替身不管端点校验，端点校验见 tests/fixtures/push-endpoints.json */
export const SERVICE_ORIGIN = /^https:\/\/(?:[a-z0-9-]+\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com)$/;

export interface CheckContext {
  subscribers: readonly PushSubscriber[];
  vapid: FakeVapidOptions | undefined;
  maxBodyBytes: number;
  nowSec: number;
}

export interface CheckResult {
  /** 不为 null 就按它回，不再看规则（也不消耗规则次数，代码审查 S6） */
  reject: PushReply | null;
  vapid: VapidResult | null;
  subscriber: PushRequestRecord['subscriber'];
  payload: string | null;
}

const text = (status: number, why: string) => reply.status(status, { 'content-type': 'text/plain' }, why);

function pathOf(endpoint: string | null): string | null {
  if (endpoint === null) return null;
  try {
    const u = new URL(endpoint);
    return u.pathname + u.search;
  } catch {
    return null;
  }
}

async function findSubscriber(inc: Incoming, subs: readonly PushSubscriber[], body: Aes128gcmBody) {
  const u = new URL(inc.url);
  const here = u.pathname + u.search;
  const order = subs.map((s, index) => ({ s, index })).sort((a, b) => Number(pathOf(b.s.endpoint) === here) - Number(pathOf(a.s.endpoint) === here));
  for (const { s, index } of order) {
    try {
      const payload = await decryptRecord(s, body);
      return { subscriber: { index, p256dh: s.p256dh, endpoint: s.endpoint }, payload };
    } catch {
      // 不是这个订阅方的，试下一个
    }
  }
  return null;
}

export async function checkPushRequest(inc: Incoming, ctx: CheckContext): Promise<CheckResult> {
  const out: CheckResult = { reject: null, vapid: null, subscriber: null, payload: null };
  if (inc.body.length > ctx.maxBodyBytes) {
    out.reject = text(413, 'payload_too_large');
    return out;
  }
  const encOk = inc.headers.get('content-encoding') === 'aes128gcm';
  const parsed = encOk ? parseAes128gcm(inc.body) : 'bad_encoding';
  if (ctx.subscribers.length > 0 && typeof parsed !== 'string') {
    const hit = await findSubscriber(inc, ctx.subscribers, parsed);
    if (hit) [out.subscriber, out.payload] = [hit.subscriber, hit.payload];
  }
  const v = ctx.vapid;
  if (!v) return out;

  // aud 绑定本次请求的源：进程内是请求地址的源；端口模式（地址是替身自己）是解开负载的订阅方的真实端点的源
  const reqOrigin = new URL(inc.url).origin;
  const endpoint = out.subscriber?.endpoint ?? null;
  const expected = SERVICE_ORIGIN.test(reqOrigin) ? reqOrigin : endpoint !== null ? new URL(endpoint).origin : null;
  const custom = v.audienceOk;
  const portMode = !SERVICE_ORIGIN.test(reqOrigin);
  const unbound = !custom && portMode && expected === null;
  const audienceOk = custom ? (aud: string) => custom(aud, expected) : (aud: string) => expected !== null && aud === expected;
  out.vapid = await checkVapid(inc.headers.get('authorization') ?? '', {
    audienceOk,
    nowSec: ctx.nowSec,
    ...(v.maxExpiresInSec !== undefined ? { maxExpiresInSec: v.maxExpiresInSec } : {}),
    ...(v.publicKey !== undefined ? { publicKey: v.publicKey } : {}),
  });

  if (unbound && !out.vapid.ok && out.vapid.why === 'bad_aud') {
    // 谁都没解开时，真正的毛病是负载，按 decrypt_failed（400）记；解开了但订阅方没带 endpoint 才是 aud_unbound
    const undecrypted = ctx.subscribers.length > 0 && out.subscriber === null;
    out.vapid = { ok: false, why: undecrypted ? 'decrypt_failed' : 'aud_unbound' };
  }
  let why: string | null = out.vapid.ok ? null : out.vapid.why;
  let status = why === 'decrypt_failed' ? 400 : 403;
  const contentType = (inc.headers.get('content-type') ?? '').split(';')[0]?.trim();
  if (!why && (v.requireTtl ?? true) && !/^\d+$/.test(inc.headers.get('ttl') ?? '')) [why, status] = ['missing_ttl', 400];
  if (!why && !encOk) [why, status] = ['bad_encoding', 400];
  if (!why && contentType !== 'application/octet-stream') [why, status] = ['bad_content_type', 400];
  if (!why && typeof parsed === 'string') [why, status] = [parsed, 400];
  if (!why && ctx.subscribers.length > 0 && out.subscriber === null) [why, status] = ['decrypt_failed', 400];
  if (out.vapid.ok && why) out.vapid = { ok: false, why };
  if (why && v.enforce !== false) out.reject = text(status, why);
  return out;
}
