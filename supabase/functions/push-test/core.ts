// push-test（架构第 6 节函数表 push-test 行、0.49 第 6 条、0.50；B2 任务单 BE-6，架构审 D6；安全审查 D1-5）：
// 给调用者本人的每台设备发一条测试通知，回每台设备的结果。设置 › 提醒“发一条测试通知”（FA-4）和推送链路冒烟用。
//   • 鉴权：用户 JWT（网关 verify_jwt 默认开着）→ requireActiveUser（停用、冷静期、会话被移除都拒绝）；照查版本（index.ts 入口处
//     versionGate('push-test')，不进免查名单）；不加 CORS（0.48 第 4 条），浏览器经 /sb 同源调用；
//   • 顺序：方法 → 鉴权 → 替身配置（线上设了 PUSH_SERVICE_OVERRIDE_URL 回 500 misconfigured，一条不发，D1-8：验完 JWT 才回）
//     → VAPID 钥匙 → 限流（push-test:<user_id>:<UTC 小时>，每人每小时 5 次，private.take_rate，窗口 3600 秒）→ 本人的设备 → 发；
//   • 负载只有 {v: 1, type: 'test', user_id}（_shared/push/payload.ts 的 buildPayload，0.53 第 4 条），文案在 SW 本地词典（push.test），
//     不带任何条目内容；加密时同样补齐到 1024 字节一档（ece.ts PAD_TIERS）；端点、密钥照 5.3 校验（_shared/push/send.ts 的 deliver）；
//   • 返回只给枚举（D1-5）：{results: [{device_id, result}]}，result 只有 ok、gone、failed、bad_endpoint 四种——
//     bad_keys 并进 bad_endpoint（订阅不能用，客户端都是重新订阅）；vapid_rejected、too_large、rate_limited、redirect、timeout、network、
//     payload_too_large、failed 一律并成 failed（不让用户分辨“连不上”“超时”“被重定向”，push-test 当不了探测工具）；
//     不回状态码、响应头、响应体、耗时，不回端点；
//   • 只读：不改 devices（410 删订阅、push_fail_count 都留给 push-dispatch；测试通知的结果只回给用户），不写 logs。
//     函数日志只记错误码，不带 user_id、端点。
// 纯逻辑：依赖全部注入（tests/functions/push-test.test.ts 用推送替身跑）；不 import npm 包、不碰 Deno 全局、不 import _shared/gen/。
import type { PayloadInput } from '../_shared/push/payload.ts';
import type { DeliverResult, Device, PushOptions } from '../_shared/push/send.ts';
import type { Override } from '../_shared/push/stub.ts';
import type { VapidKeys, VapidLoad } from '../_shared/push/vapid.ts';

export const HOURLY_LIMIT = 5;
export const WINDOW_S = 3600;
/** 测试通知：不急、过 10 分钟没送到就算了 */
export const TEST_PUSH_OPTIONS: PushOptions = { ttl: 600, urgency: 'normal' };
/** 一次最多发几台（一个人的设备不会多；防止异常数据把一次请求拖长） */
export const MAX_DEVICES = 20;

export type TestResult = 'ok' | 'gone' | 'failed' | 'bad_endpoint';
export const TEST_RESULTS: readonly TestResult[] = ['ok', 'gone', 'failed', 'bad_endpoint'];

export interface TestDevice extends Device {
  id: string;
}

export interface Store {
  /** private.take_rate(key, limit, window_s)：还在额度内回 true */
  takeRate(key: string, limit: number, windowS: number): Promise<boolean>;
  /** 本人的设备：user_id = 本人、deleted_at 为空、push_endpoint 不为空 */
  devices(userId: string): Promise<TestDevice[]>;
}

/** requireActiveUser 的结果里用到的部分（不 import _shared/auth.ts：它带 npm: 导入，Vitest 一侧类型检查认不了） */
export type AuthResult = { ok: true; user: { userId: string } } | { ok: false; response: Response; code: string };

export interface Deps {
  authenticate(req: Request): Promise<AuthResult>;
  store: Store;
  /** resolveOverride(PUSH_SERVICE_OVERRIDE_URL, SUPABASE_URL, LEMO_LOCAL_PUSH_STUB) 的结果 */
  override: Override;
  vapid(): Promise<VapidLoad>;
  buildPayload(p: PayloadInput): Uint8Array<ArrayBuffer>;
  /** _shared/push/send.ts 的 deliver，已绑好 fetch、签名器、替身地址 */
  deliver(dev: Device, payload: Uint8Array<ArrayBuffer>, opt: PushOptions, keys: VapidKeys, override: string | null): Promise<DeliverResult>;
  now(): number;
  log(code: string): void;
}

import { json } from '../_shared/http.ts';
const err = (status: number, code: string): Response => json(status, { error: code });

/** 计数键（附录 A 三段写法，第三段是 UTC 小时 yyyymmddhh，不含冒号；单测核对过得了 counters 的 check 约束） */
export function rateKey(userId: string, ms: number): string {
  return `push-test:${userId}:${new Date(ms).toISOString().slice(0, 13).replace(/[-T]/g, '')}`;
}

/** deliver 的结果收成四种（D1-5） */
export function toTestResult(r: DeliverResult): TestResult {
  switch (r.outcome) {
    case 'ok': return 'ok';
    case 'gone': return 'gone';
    case 'bad_endpoint':
    case 'bad_keys': return 'bad_endpoint';
    default: return 'failed';
  }
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return err(405, 'method_not_allowed');
  const auth = await deps.authenticate(req);
  if (!auth.ok) return auth.response;
  const userId = auth.user.userId;
  if (!deps.override.ok) {
    deps.log('misconfigured:override');
    return err(500, 'misconfigured');
  }
  const override = deps.override.url;
  const v = await deps.vapid();
  if (!v.ok) {
    deps.log(`misconfigured:${v.reason}`);
    return err(500, 'misconfigured');
  }
  try {
    if (!(await deps.store.takeRate(rateKey(userId, deps.now()), HOURLY_LIMIT, WINDOW_S))) return err(429, 'rate_limited');
  } catch {
    deps.log('store:take_rate');
    return err(503, 'try_later');
  }
  let devices: TestDevice[];
  try {
    devices = (await deps.store.devices(userId)).slice(0, MAX_DEVICES);
  } catch {
    deps.log('store:devices');
    return err(503, 'try_later');
  }
  const payload = deps.buildPayload({ type: 'test', user_id: userId });
  const results = await Promise.all(devices.map(async (d) => {
    let r: DeliverResult;
    try {
      r = await deps.deliver(d, payload, TEST_PUSH_OPTIONS, v.keys, override);
    } catch {
      r = { outcome: 'failed' };
    }
    return { device_id: d.id, result: toTestResult(r) };
  }));
  return json(200, { results });
}
