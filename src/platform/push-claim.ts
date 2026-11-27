// 启动时把网页推送订阅好、认领到当前账号（换账号后推送不能发错人）
// • 换账号、退出时 disconnectBrowserPush 已退订旧订阅，所以新账号启动后在这里重订、再认领
// • 只在通知权限已是 granted 时做（不在启动时弹权限框，只在设置 › 提醒的开关点按里请求）；exe 不做
// • subscribePush：已有订阅且公钥相同原样用，否则重订（iOS 不在点按里可能订不上，返回 resubscribe_failed）
// • 认领 claim_endpoint：
//   - 服务器把订阅写到本会话那一行 devices 上，所以先等 ensureDevice 登记好再认领；登记不上算“稍后重试”
//   - 同一“账号 + 会话 + endpoint”认领过、订阅没换就不再调；取不到会话就不跳过
//   - endpoint_in_use：同账号别的设备行占着，交给设置 › 提醒显示“移除它”，这里不记
//   - device_not_found：忘掉缓存的旧 id，补登记、再认领一次；仍不行记“稍后重试”（不记成不支持）
//   - endpoint_not_allowed / bad_push_keys：显示暂不支持，不重试、不进 outbox；30 天内不再问（以后白名单扩大还能再试）
//   - 断网、其他错误：不记，下次启动再试
// • 本机记录不存明文，只存 SHA-256 摘要的 base64url 前 22 字符；不记 p256dh、auth。算不出摘要就照常认领。
//   退出、被移除、换账号时由 push.ts 的 forgetPushClaim 删键
// • 几个标签页同时启动：认领包在 'lemo-push-claim:<user_id>' 锁里一个一个来，后来的读到记录就不再调
import { b64uEncode } from '../../shared/core/b64url.ts';
import { strOrNull } from '../../shared/core/field.ts';
import type { NetResult } from '../../shared/schema/sync.ts';
import { isTauri } from './env.ts';
import { CLAIM_STORAGE_KEY, subscribePush, type PushSubscribeResult } from './push.ts';

export { CLAIM_STORAGE_KEY } from './push.ts';

// ClaimArgs、claimParams 在 supabase/claim-params.ts（同步层不把 push.ts 拉进依赖图）；这里原样转出
import type { ClaimArgs } from './supabase/claim-params.ts';

export { claimParams, type ClaimArgs } from './supabase/claim-params.ts';

/** 占着这个 endpoint 的同账号设备行（“移除它”用） */
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
  /** 调 claim_endpoint（sync-transport.ts 的 claimEndpoint） */
  readonly claim: (args: ClaimArgs) => Promise<NetResult<unknown>>;
  /** devices.platform（devicePlatform） */
  readonly platform: string;
  /** devices.label（≤ 80 字；默认按 userAgent 粗分） */
  readonly label?: string;
  readonly win?: object;
  readonly permission?: () => NotificationPermission;
  readonly subscribe?: () => Promise<PushSubscribeResult>;
  readonly storage?: () => KeyValueLike | null;
  /** 本机令牌里的 session_id；读不到就每次都认领 */
  readonly sessionId?: () => string | null;
  /** 本机会话里现在的 user_id：不等于 userId 就回 claim_failed。不给就不比 */
  readonly currentUserId?: () => string | null;
  /** 登记或复用本会话的 devices 行；返回 null = 这次登记不上，不认领 */
  readonly ensureDevice?: () => Promise<string | null>;
  /** 设备行在服务器上不在了：清掉缓存的那个 id，之后 ensureDevice 重新登记 */
  readonly invalidateDevice?: (id: string) => Promise<void>;
  /** 跨标签页互斥（withLock）；不给就直接跑 */
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

/** “不支持”的记录多久以后失效、重新问一次 */
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
 * 会话还是这个账号（没给 currentUserId 时当作是）。订阅前、每次认领前各同步比一次。
 * 已知窗口（接受）：比完到 supabase-js 异步取令牌之间隔几个微任务，别的标签页恰好此时登录 B，认领会按 A 的令牌发出、
 * endpoint 暂归 A，直到 watchAccount 发现换账号、整页重载后 B 再认领回来
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
