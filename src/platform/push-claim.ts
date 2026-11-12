// 启动时把网页推送订阅好、认领到当前账号（B2 任务单 FA-1“订阅、认领”，验收“换账号后推送不会发错人”；风险 R1；0.38 第 35 条）
// • 换账号、退出时 disconnectBrowserPush 已退订旧账号的订阅（FE-2），所以新账号启动后要在这里重订、再认领
// • 只在通知权限已经是 granted 时做（不在启动时弹权限框：第一次请求权限只在设置 › 提醒的开关点按里，FA-4）；exe 不做（没有网页推送）
// • subscribePush：已有订阅且公钥相同原样用；没有或公钥换了就重订（R-282 ③：iOS 不在点按里可能订不上，返回 resubscribe_failed，
//   设置 › 提醒据此提示“推送需要重新打开，点一下”）
// • 认领 claim_endpoint(endpoint, p256dh, auth, label, platform)（“接口先定”第 1 条）：
//   - 服务器把订阅写到“本会话那一行 devices”上，所以先等本会话的设备行登记好（ensureDevice）再认领（代码审查 M3、安全审查 S1）；
//     登记不上就这次不认领，算“稍后重试”
//   - 同一个“账号 + 会话 + endpoint”认领过、订阅也没换，就不再调（每次启动不多发一个请求）；取不到会话就不跳过，照常认领（安全审查 FA2-2）
//   - {ok: true}：记下认领
//   - {error: 'endpoint_in_use', holder}：同账号别的设备行占着（0.29 续第 105 条），交给设置 › 提醒显示“移除它”（FA-4），这里不记
//   - device_not_found（本会话的设备行不在，后端 BE-1 新增）：invalidateDevice 忘掉缓存的旧 id，补登记一次、再认领一次；
//     仍不行记“稍后重试”（不记成不支持）
//   - 22023 的 endpoint_not_allowed / bad_push_keys：显示“这个浏览器的推送服务暂不支持”，不重试、不进 outbox（D1、M4）；
//     记下这个 endpoint 不支持，30 天内启动不再问（安全审查 S6：以后白名单扩大还能再试）
//   - 断网、其他错误：不记，下次启动再试
// • 本机记录（安全审查 FA2-1）：不存明文，只存 SHA-256 摘要（“已认领”是 user_id + session_id + endpoint，“不支持”只按 endpoint），
//   取 base64url 前 22 个字符；不记 p256dh、auth。摘要算不出来（没有 crypto.subtle）就当没认领、照常认领。
//   退出、被移除、换账号时 disconnectBrowserPush 删掉这个键（push.ts 的 forgetPushClaim）
// • 几个标签页同时启动：认领包在 'lemo-push-claim:<user_id>' 锁里一个一个来（安全审查 S2），后来的读到记录就不再调
import { b64uEncode } from '../../shared/core/b64url.ts';
import type { NetResult } from '../../shared/schema/sync.ts';
import { isTauri } from './env.ts';
import { CLAIM_STORAGE_KEY, subscribePush, type PushSubscribeResult } from './push.ts';

export { CLAIM_STORAGE_KEY } from './push.ts';

// ClaimArgs、claimParams 搬到 supabase/claim-params.ts（代码审查建议 3：同步层不再把 push.ts 拉进依赖图）；这里原样转出
import type { ClaimArgs } from './supabase/claim-params.ts';

export { claimParams, type ClaimArgs } from './supabase/claim-params.ts';

/** 占着这个 endpoint 的同账号设备行（第 105 条，FA-4 的“移除它”用） */
export interface EndpointHolder {
  readonly id: string;
  readonly label: string | null;
  readonly last_seen_at: string | null;
  readonly install_id: string | null;
}

export type ClaimResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'endpoint_in_use'; readonly holder: EndpointHolder }
  | { readonly ok: false; readonly reason: 'not_supported' | 'device_not_found' | 'failed' };

/** 服务器拒收地址或密钥的两个码（22023，HTTP 400） */
const NOT_SUPPORTED_CODES = new Set(['endpoint_not_allowed', 'bad_push_keys']);

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** claim_endpoint 的返回（或失败）→ ClaimResult；形状不认识的一律 failed */
export function parseClaimResult(r: NetResult<unknown>): ClaimResult {
  if (!r.ok) {
    const code = r.error.code;
    if (code && NOT_SUPPORTED_CODES.has(code)) return { ok: false, reason: 'not_supported' };
    return { ok: false, reason: code === 'device_not_found' ? 'device_not_found' : 'failed' };
  }
  const v = r.value;
  if (typeof v !== 'object' || v === null) return { ok: false, reason: 'failed' };
  const o = v as Record<string, unknown>;
  if (o['ok'] === true) return { ok: true };
  const h = o['holder'];
  if (o['error'] === 'endpoint_in_use' && typeof h === 'object' && h !== null) {
    const x = h as Record<string, unknown>;
    const id = x['id'];
    if (typeof id === 'string' && id) {
      return {
        ok: false, reason: 'endpoint_in_use',
        holder: { id, label: strOrNull(x['label']), last_seen_at: strOrNull(x['last_seen_at']), install_id: strOrNull(x['install_id']) },
      };
    }
  }
  return { ok: false, reason: 'failed' };
}

export interface KeyValueLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export interface EnsurePushDeps {
  /** 当前账号（启动时读到的会话 user_id） */
  readonly userId: string;
  /** 调 claim_endpoint（platform/supabase/sync-transport.ts 的 claimEndpoint） */
  readonly claim: (args: ClaimArgs) => Promise<NetResult<unknown>>;
  /** devices.platform（device-info.ts 的 devicePlatform） */
  readonly platform: string;
  /** devices.label（≤ 80 字；默认按 userAgent 粗分） */
  readonly label?: string;
  readonly win?: object;
  readonly permission?: () => NotificationPermission;
  readonly subscribe?: () => Promise<PushSubscribeResult>;
  readonly storage?: () => KeyValueLike | null;
  /** 本机令牌里的 session_id（platform/session.ts 的 readSessionId）；读不到就每次都认领 */
  readonly sessionId?: () => string | null;
  /**
   * 本机会话里现在的 user_id（platform/session.ts 的 readSessionUserId，FA6-r3-low L9）：订阅前、每次认领前同步比一次，
   * 不等于 userId（别的标签页换了账号、退出了）就回 claim_failed。不给就不比（测试）
   */
  readonly currentUserId?: () => string | null;
  /** 登记或复用本会话的 devices 行（core/device-reg.ts 的 ensure）；返回 null = 这次登记不上，不认领 */
  readonly ensureDevice?: () => Promise<string | null>;
  /** 设备行在服务器上不在了：清掉缓存的那个 id（core/device-reg.ts 的 invalidate），之后 ensureDevice 重新登记 */
  readonly invalidateDevice?: (id: string) => Promise<void>;
  /** 跨标签页互斥（platform/device-info.ts 的 withLock）；不给就直接跑 */
  readonly lock?: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly now?: () => number;
  /** 算摘要（测试换掉）；默认 crypto.subtle 的 SHA-256 */
  readonly digest?: (text: string) => Promise<string | null>;
}

export type EnsurePushResult =
  | 'tauri'
  | 'not_granted'
  | 'claimed'
  | 'already'
  | 'endpoint_in_use'
  | 'not_supported'
  | 'claim_failed'
  | 'device_pending'
  | Exclude<PushSubscribeResult, { ok: true }>['reason'];

export interface EnsurePushOutcome {
  readonly result: EnsurePushResult;
  /** endpoint_in_use 时占着的那一行（交给设置 › 提醒） */
  readonly holder?: EndpointHolder;
}

const defaultPermission = (): NotificationPermission => (typeof Notification !== 'undefined' ? Notification.permission : 'default');
const defaultStorage = (): KeyValueLike | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** devices.label 的默认值：只按 userAgent 粗分设备类型，不带版本号 */
export function defaultPushLabel(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  return 'Web';
}

/** “不支持”的记录多久以后失效、重新问一次（安全审查 S6） */
export const UNSUPPORTED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** SHA-256 → base64url 前 22 个字符（132 位）；算不出来返回 null */
export async function sha256Short(text: string): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    return b64uEncode(new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text)))).slice(0, 22);
  } catch {
    return null;
  }
}

function read(s: KeyValueLike | null): string | null {
  try {
    return s?.getItem(CLAIM_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function write(s: KeyValueLike | null, v: string): void {
  try {
    s?.setItem(CLAIM_STORAGE_KEY, v);
  } catch {
    // 存不下：下次启动再认领一次，无害
  }
}

/** 启动时：权限已给就订好、认领到当前账号。永远 resolve，不抛 */
export async function ensurePushSubscription(deps: EnsurePushDeps): Promise<EnsurePushOutcome> {
  try {
    if (isTauri(deps.win ?? globalThis)) return { result: 'tauri' };
    if ((deps.permission ?? defaultPermission)() !== 'granted') return { result: 'not_granted' };
    const lock = deps.lock ?? (<T>(fn: () => Promise<T>) => fn());
    return await lock(() => claimOnce(deps));
  } catch {
    return { result: 'claim_failed' };
  }
}

/**
 * 会话还是这个账号（没给 currentUserId 时当作是）。订阅前、第一次认领前、补登记后第二次认领前各同步比一次（FA6-r3-low L9）。
 * 剩下的已知窗口（首屏判断放宽与推送认领核对审查 L3，不改代码，只记下来）：比完以后 deps.claim → transport.claimEndpoint 里，
 * supabase-js 还要异步取令牌（可能顺带刷新），中间隔着几个微任务。只有别的标签页恰好在这几个微任务里登录了 B、
 * 而本页 supabase-js 内存里的会话还是 A 时才会碰上：认领按 A 的令牌发出，这台浏览器的 endpoint 归回 A，A 的提醒会推到已经换成 B 的这台浏览器上；
 * 持续到本页被 watchAccount 发现换账号、整页重新载入，B 的启动认领把 endpoint 拿回去为止。窗口只有几个微任务，比 L9 以前小几个数量级，接受。
 * 写法同 sign-out.ts 文件头“剩下的已知问题”
 */
const stillOwner = (deps: EnsurePushDeps): boolean => !deps.currentUserId || deps.currentUserId() === deps.userId;

async function claimOnce(deps: EnsurePushDeps): Promise<EnsurePushOutcome> {
  if (!stillOwner(deps)) return { result: 'claim_failed' };
  const sub = await (deps.subscribe ?? (() => subscribePush({ win: deps.win ?? globalThis })))();
  if (!sub.ok) return { result: sub.reason };
  const digest = deps.digest ?? sha256Short;
  const now = (deps.now ?? Date.now)();
  const store = (deps.storage ?? defaultStorage)();
  const before = read(store);
  const sid = deps.sessionId?.() ?? null;
  const okKey = sid ? await digest(`${deps.userId}\n${sid}\n${sub.sub.endpoint}`) : null;
  if (okKey !== null && before === `ok\n${okKey}` && !sub.changed) return { result: 'already' };
  const epKey = await digest(sub.sub.endpoint);
  if (epKey !== null && before?.startsWith(`unsupported\n${epKey}\n`)) {
    const at = Number(before.slice(`unsupported\n${epKey}\n`.length));
    if (Number.isFinite(at) && now - at >= 0 && now - at < UNSUPPORTED_TTL_MS) return { result: 'not_supported' };
  }
  const devId = deps.ensureDevice ? await deps.ensureDevice() : null;
  if (deps.ensureDevice && devId === null) return { result: 'device_pending' };
  const args = { endpoint: sub.sub.endpoint, p256dh: sub.sub.p256dh, auth: sub.sub.auth, label: (deps.label ?? defaultPushLabel()).slice(0, 80), platform: deps.platform };
  if (!stillOwner(deps)) return { result: 'claim_failed' };
  let r = parseClaimResult(await deps.claim(args));
  if (!r.ok && r.reason === 'device_not_found' && deps.ensureDevice) {
    // 设备行不在（刚被清理、或登记的回包丢了）：先忘掉缓存的旧 id，补登记一次、再认领一次
    if (devId !== null) await deps.invalidateDevice?.(devId);
    if ((await deps.ensureDevice()) === null) return { result: 'device_pending' };
    if (!stillOwner(deps)) return { result: 'claim_failed' };
    r = parseClaimResult(await deps.claim(args));
  }
  if (r.ok) {
    if (okKey !== null) write(store, `ok\n${okKey}`);
    return { result: 'claimed' };
  }
  if (r.reason === 'endpoint_in_use') return { result: 'endpoint_in_use', holder: r.holder };
  if (r.reason === 'not_supported') {
    if (epKey !== null) write(store, `unsupported\n${epKey}\n${now}`);
    return { result: 'not_supported' };
  }
  // device_not_found 补登记后仍不行、断网、其他错误：稍后重试（不记）
  return { result: 'claim_failed' };
}
