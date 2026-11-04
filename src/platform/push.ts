// 网页推送订阅（架构 5.3“订阅”、4.1；B2 任务单 FA-1，第一天派工表第 9 行里不需要真公钥的部分）
// • 公钥读 buildInfo.vapidKey（VITE_PUBLIC_VAPID_KEY，A14），base64url 解码后必须是 65 字节、首字节 0x04（P-256 未压缩点）；
//   没配或格式不对一律不订阅（no_key / bad_key），不拿坏公钥去问浏览器
// • exe（Tauri 窗口）不走网页推送：直接返回 tauri（提醒由 exe 自己的本地通知管，B6-exe），判断复用 env.ts 的 isTauri
// • 已有订阅且公钥相同：原样返回（changed = false）；新订的（第一次或换了公钥）changed = true，调用方要重新登记；公钥换了（运维轮换 VAPID）：先退订旧的再订新的（changed = true），
//   旧订阅用新公钥签的推送会被推送服务拒掉，不退订就再也收不到
// • 订阅结果只交 endpoint、p256dh、auth 三样给调用方；登记到服务器（claim_endpoint）等后端 BE-1 的接口定了再接，这里不发请求
// • 浏览器权限：pushManager.subscribe({ userVisibleOnly: true }) 自己会弹权限框，要在用户点按里调；已拒绝的直接返回 denied
import { buildInfo, isTauri } from './env.ts';
import { closeAllLocalReminders } from './native-bridge.ts';

/** P-256 未压缩公钥：0x04 + 32 字节 x + 32 字节 y */
export const VAPID_KEY_BYTES = 65;

/** 交给服务器登记的三样（和 PushSubscription.toJSON() 的 endpoint、keys 对应） */
export interface PushEndpoint {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export type PushSubscribeResult =
  | { readonly ok: true; readonly sub: PushEndpoint; readonly changed: boolean }
  | {
      readonly ok: false;
      /**
       * tauri：exe 不用网页推送；unsupported：浏览器没有 SW / PushManager（iPhone 不在主屏幕模式时也是这样）；
       * no_key / bad_key：没配公钥、公钥格式不对；no_sw：SW 还没注册上；denied：通知权限被拒；failed：订阅本身出错；
       * resubscribe_failed：公钥换了、旧订阅已退掉，新的没订上（设置 › 提醒提示“推送需要重新打开，点一下”，R-282 ③）
       */
      readonly reason: 'tauri' | 'unsupported' | 'no_key' | 'bad_key' | 'no_sw' | 'denied' | 'failed' | 'resubscribe_failed';
    };

/** 用到的浏览器部分（测试时传假的） */
export interface PushEnv {
  /** 判断 exe 用（默认 globalThis） */
  readonly win?: object;
  /** 默认 buildInfo.vapidKey */
  readonly key?: string;
  /** 取本 App 的 SW 注册（默认 navigator.serviceWorker.getRegistration('/app/')）；没有返回 null */
  readonly registration?: () => Promise<Pick<ServiceWorkerRegistration, 'pushManager'> | null>;
  /** 当前通知权限（默认 Notification.permission；没有 Notification 时当 default） */
  readonly permission?: () => NotificationPermission;
}

/** base64url（可带可不带 = 补位）→ 字节；不是合法的 base64url 返回 null */
function fromB64u(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(s)) return null;
  const b64 = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (b64.length % 4 === 1) return null;
  try {
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** 字节 → base64url（不补位） */
function toB64u(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  const b = new Uint8Array(buf);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 解 VAPID 公钥：65 字节、首字节 0x04 才算数，否则 null */
export function decodeVapidKey(key: string): Uint8Array<ArrayBuffer> | null {
  const b = fromB64u(key.trim());
  if (!b || b.length !== VAPID_KEY_BYTES || b[0] !== 0x04) return null;
  const out = new Uint8Array(new ArrayBuffer(VAPID_KEY_BYTES));
  out.set(b);
  return out;
}

function sameBytes(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
}

function endpointOf(sub: PushSubscription): PushEndpoint | null {
  const p256dh = toB64u(sub.getKey('p256dh'));
  const auth = toB64u(sub.getKey('auth'));
  return sub.endpoint && p256dh && auth ? { endpoint: sub.endpoint, p256dh, auth } : null;
}

const defaultRegistration = async (): Promise<ServiceWorkerRegistration | null> => {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  if (!sw) return null;
  return (await sw.getRegistration('/app/')) ?? null;
};

const defaultPermission = (): NotificationPermission => (typeof Notification !== 'undefined' ? Notification.permission : 'default');

/** 支不支持网页推送（不看权限，只看浏览器有没有这套接口） */
function pushSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof PushManager !== 'undefined';
}

/**
 * 订阅网页推送（要在用户点按里调：第一次会弹权限框）。公钥相同的已有订阅原样返回；公钥换了先退订再订。
 * 永远 resolve，不抛
 */
export async function subscribePush(env: PushEnv = {}): Promise<PushSubscribeResult> {
  if (isTauri(env.win ?? globalThis)) return { ok: false, reason: 'tauri' };
  const keyText = env.key ?? buildInfo.vapidKey;
  if (!keyText) return { ok: false, reason: 'no_key' };
  const key = decodeVapidKey(keyText);
  if (!key) return { ok: false, reason: 'bad_key' };
  if (!env.registration && !pushSupported()) return { ok: false, reason: 'unsupported' };
  if ((env.permission ?? defaultPermission)() === 'denied') return { ok: false, reason: 'denied' };
  let reg: Pick<ServiceWorkerRegistration, 'pushManager'> | null;
  try {
    reg = await (env.registration ?? defaultRegistration)();
  } catch {
    return { ok: false, reason: 'no_sw' };
  }
  if (!reg) return { ok: false, reason: 'no_sw' };
  if (!reg.pushManager) return { ok: false, reason: 'unsupported' };
  let unsubscribed = false;
  try {
    const old = await reg.pushManager.getSubscription();
    if (old) {
      const oldKey = old.options.applicationServerKey;
      // 读不到旧公钥（null，个别浏览器、老订阅）：当作没换，原样用（代码审查 S6：不然每次都退订再订，endpoint 一直变，
      // iOS 不在点按里可能订不回来）。能读到、又不一样才重订
      const keyChanged = oldKey !== null && oldKey !== undefined && !sameBytes(oldKey, key);
      const ep = endpointOf(old);
      if (!keyChanged && ep) return { ok: true, sub: ep, changed: false };
      // 公钥换了（或旧订阅缺 keys）：先退订再订新的
      unsubscribed = await old.unsubscribe().catch(() => false);
    }
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const ep = endpointOf(sub);
    if (ep) return { ok: true, sub: ep, changed: true };
    return { ok: false, reason: unsubscribed ? 'resubscribe_failed' : 'failed' };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotAllowedError') return { ok: false, reason: 'denied' };
    // 旧订阅已退掉、新的没订上：设置 › 提醒据此提示“推送需要重新打开，点一下”（R-282 ③）
    return { ok: false, reason: unsubscribed ? 'resubscribe_failed' : 'failed' };
  }
}

/**
 * 退订（关掉提醒、退出登录时用）：没有订阅也算成功。返回退订前的 endpoint，调用方据此让服务器删 devices 行；
 * exe、不支持、取不到 SW 都返回 null。永远 resolve
 */
export async function unsubscribePush(env: Pick<PushEnv, 'win' | 'registration'> = {}): Promise<string | null> {
  if (isTauri(env.win ?? globalThis)) return null;
  if (!env.registration && !pushSupported()) return null;
  try {
    const reg = await (env.registration ?? defaultRegistration)();
    const sub = await reg?.pushManager?.getSubscription();
    if (!sub) return null;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    return endpoint;
  } catch {
    return null;
  }
}

/** 退出时断开浏览器推送最多等多久（关通知 + 退订；B2 安全审查 FE-2：失败、超时都不能卡住退出） */
export const DISCONNECT_PUSH_MS = 2000;

/** disconnectBrowserPush 用到的 SW 注册部分 */
export type PushRegistrationLike = Pick<ServiceWorkerRegistration, 'pushManager' | 'getNotifications'>;

/** 本机记“已认领 / 不支持”的键（push-claim.ts 写；值只有摘要，见那边的文件头） */
export const CLAIM_STORAGE_KEY = 'lemo.push.claimed';

/** 删掉本机的认领记录（退出、被移除、换账号都经 disconnectBrowserPush 走到这里）；不抛 */
export function forgetPushClaim(storage?: () => Storage | null): void {
  try {
    (storage ? storage() : globalThis.localStorage)?.removeItem(CLAIM_STORAGE_KEY);
  } catch {
    // 读不了 localStorage：没有可删的
  }
}

/**
 * 退出、被移除、注销、换账号时把浏览器这一侧断开（B2 安全审查六之三 FE-2）：
 * ① 关掉本 App 已显示的所有通知（通知中心里不留上一个账号的标题；getNotifications 不支持就跳过）
 * ② 退订推送（unsubscribePush），旧账号的推送哪怕服务器没删掉 devices 行也到不了这台设备。
 *    通知权限不是 granted 时不退订（B2 FA-3 安全审查 PUSH-getsub-hang，P-1～P-6）：此时推送显示不出来，
 *    残留订阅由删 devices 行、claim 第 d 步和 FE-1 兜。只有 Notification 存在、且权限明确是 denied / default 才跳过；
 *    没有 Notification、读取抛错都照常退订（拿不准就退订）。跳过的只是退订这一步：认领记录和关通知照常先做。
 *    （Playwright 自带的 WebKit 没有推送服务，getSubscription 会卡死主线程、2 秒上限也兜不住；默认 default 权限正好走跳过）
 * 拿到的 endpoint 不记录、不交出去：服务器上的 devices 行由退出流程 ① 按会话删。
 * exe 没有网页推送：只关掉 exe 已弹出的全部本机通知（platform 桥的 closeAllLocalReminders，安全审查 X-5；
 * 和网页的“关通知、再退订”在退出流程的同一个位置）。整体最多等 ms，出错、超时都 resolve，不抛
 */
export function disconnectBrowserPush(
  env: {
    win?: object;
    registration?: () => Promise<PushRegistrationLike | null>;
    closeLocal?: () => Promise<void>;
    storage?: () => Storage | null;
    /** 当前通知权限（默认 Notification.permission；没有 Notification 时返回 null，不能当 default，见 skipUnsubscribe） */
    permission?: () => NotificationPermission | null;
  } = {},
  ms: number = DISCONNECT_PUSH_MS,
): Promise<void> {
  // 先删本机的认领记录（安全审查 FA2-1：含账号信息的键退出时不留）；网页、exe 两边都删
  forgetPushClaim(env.storage);
  const closeLocal = env.closeLocal ?? closeAllLocalReminders;
  if (isTauri(env.win ?? globalThis)) return withinMs(() => closeLocal(), ms);
  if (!env.registration && !pushSupported()) return Promise.resolve();
  const getReg = env.registration ?? defaultRegistration;
  const run = async (): Promise<void> => {
    let reg: PushRegistrationLike | null = null;
    try {
      reg = await getReg();
    } catch {
      return;
    }
    if (!reg) return;
    try {
      for (const n of await reg.getNotifications()) n.close();
    } catch {
      // 不支持 getNotifications（iOS 未核实）：照样退订
    }
    // 通知权限明确不是 granted：推送显示不出来，不退订（不调 getSubscription，P-1、P-2）
    if (skipUnsubscribe(env.permission ?? strictPermission)) return;
    await unsubscribePush({ win: env.win ?? globalThis, registration: async () => reg });
  };
  return withinMs(run, ms);
}

/**
 * 退出时读通知权限（PUSH-getsub-hang P-2）：没有 Notification 返回 null。
 * 不复用 defaultPermission：那个在没有 Notification 时返回 'default'，会把“拿不准”当成“可以不退订”
 */
const strictPermission = (): NotificationPermission | null => (typeof Notification !== 'undefined' ? Notification.permission : null);

/** 只有权限明确是 denied / default 才跳过退订；null（没有 Notification）、别的值、读取抛错都照常退订 */
function skipUnsubscribe(read: () => NotificationPermission | null): boolean {
  try {
    const p = read();
    return p === 'denied' || p === 'default';
  } catch {
    return false;
  }
}

/** 跑 fn，最多等 ms；出错、超时都 resolve（退出流程不能被卡住） */
function withinMs(fn: () => Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    let p: Promise<void>;
    try {
      p = fn();
    } catch {
      p = Promise.resolve();
    }
    p.then(
      () => (clearTimeout(t), resolve()),
      () => (clearTimeout(t), resolve()),
    );
  });
}
