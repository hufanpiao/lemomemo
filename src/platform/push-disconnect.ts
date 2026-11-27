// 退出、被移除、换账号时断开浏览器推送的入口：core/account.ts、platform/sign-out.ts 都经这里，
// 不静态引 push.ts（只在退出流程用），push.ts 到真要断开时才下载：
// • 先删本机认领记录（push-claim-key.ts，同步、不等下载）；
// • 再下载 push.ts 调 disconnectBrowserPush（关通知、退订）；
// • 下载失败、断开抛错都不抛给调用方，退出、换账号照常往下走；记一条日志 push_disconnect_fail（code 见 PushDisconnectFail），
//   入口（app/main.tsx）用 setPushDisconnectLog 接到日志总线（shared/core/log-bus.ts 的 logEvent），没接时不记（platform 不碰日志层）。
// • “下载 + 断开”整体最多 DISCONNECT_PUSH_MS，下载最多 LOAD_PUSH_MS，剩下的时间给断开或兜底；
//   下载一直不回也按时返回，记 timeout，退出流程和换账号不会卡住；
// • 下载失败或超时，走本文件里不依赖 push.ts 的兜底（fallbackDisconnect），两件事照样做：
//   网页：getRegistration('/app/') 拿注册（没注册直接结束）→ 关掉已显示的通知 → 权限是 granted 等情况下退订
//   （跳过退订的条件和 push.ts 同一套 skipUnsubscribe：Playwright 的 WebKit 没有推送服务，getSubscription 会卡死主线程）；
//   exe：关掉已弹出的全部本机通知（native-bridge.ts 的 closeAllLocalReminders，桥本来就在首屏）。兜底失败、超时记 fallback。
// exe 里 import() 不走网络：desktop/src-tauri/scripts/stage-web.mjs 把 dist/web/app 的 JS 分块全部打进安装包，
//   不会因为断网而失败或卡住；万一分块缺了，上面的兜底照样关本机通知
import { isTauri } from './env.ts';
import { withTimeout } from './exit-basics.ts';
import { closeAllLocalReminders } from './native-bridge.ts';
import { DISCONNECT_PUSH_MS, forgetPushClaim, skipUnsubscribe, strictPermission } from './push-claim-key.ts';
import type { disconnectBrowserPush } from './push.ts';

type PushModule = { disconnectBrowserPush: typeof disconnectBrowserPush };
/** load：push.ts 下载失败；timeout：下载或断开超过上限；error：断开抛错；fallback：兜底失败或超时 */
export type PushDisconnectFail = 'load' | 'timeout' | 'error' | 'fallback';

/** 下载 push.ts 最多等多久（剩下的时间留给断开或兜底；整体不超过 DISCONNECT_PUSH_MS） */
export const LOAD_PUSH_MS = DISCONNECT_PUSH_MS / 2;

/** 兜底用到的 SW 注册部分 */
export type FallbackRegistration = Pick<ServiceWorkerRegistration, 'pushManager' | 'getNotifications'>;

/** 兜底的环境（测试换；默认读浏览器） */
export interface FallbackEnv {
  win?: object;
  /** 默认 navigator.serviceWorker.getRegistration('/app/')；没有 serviceWorker、没注册都返回 null */
  registration?: () => Promise<FallbackRegistration | null>;
  permission?: () => NotificationPermission | null;
  closeLocal?: () => Promise<void>;
}

let onFail: ((code: PushDisconnectFail, error: unknown) => void) | null = null;

/** 入口接到日志总线（logEvent）；null 断开 */
export function setPushDisconnectLog(fn: ((code: PushDisconnectFail, error: unknown) => void) | null): void {
  onFail = fn;
}

function report(code: PushDisconnectFail, error: unknown): void {
  try {
    onFail?.(code, error);
  } catch {
    // 记日志出错也不挡退出
  }
}

type Outcome<T> = { kind: 'ok'; value: T } | { kind: 'fail'; error: unknown } | { kind: 'timeout' };

/**
 * 跑 start，最多等 ms；成功、失败、超时都 resolve（同步抛错算失败：传进来的 load、兜底都可能在返回 promise 之前就抛）。
 * 超时工具只有 exit-basics.ts 的 withTimeout 一份：成功、失败先在里面变成结果，到点才给 timeout
 */
function within<T>(start: () => Promise<T>, ms: number): Promise<Outcome<T>> {
  const run = (): Promise<Outcome<T>> =>
    Promise.resolve().then(start).then((value) => ({ kind: 'ok', value }), (error: unknown) => ({ kind: 'fail', error }));
  return withTimeout(run, Math.max(0, ms), () => ({ kind: 'timeout' }));
}

// 用 getRegistration('/app/')（和 push.ts 同一个 scope），没注册就立刻结束；
// 不用 serviceWorker.ready：没有 SW 时它永远不回，会等满剩余时间再记一条 fallback
const currentRegistration = async (): Promise<FallbackRegistration | null> => {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  return sw ? ((await sw.getRegistration('/app/')) ?? null) : null;
};

/** 不依赖 push.ts 的最小断开：网页关通知、退订；exe 关本机通知。出错往外抛（调用方记 fallback） */
export async function fallbackDisconnect(env: FallbackEnv = {}): Promise<void> {
  if (isTauri(env.win ?? globalThis)) {
    await (env.closeLocal ?? closeAllLocalReminders)();
    return;
  }
  const reg = await (env.registration ?? currentRegistration)();
  if (!reg) return;
  try {
    for (const n of await reg.getNotifications()) n.close();
  } catch {
    // 不支持 getNotifications：照样退订
  }
  if (skipUnsubscribe(env.permission ?? strictPermission)) return;
  if (!env.registration && typeof PushManager === 'undefined') return;
  const sub = await reg.pushManager.getSubscription();
  await sub?.unsubscribe();
}

/**
 * 断开浏览器推送：永远 resolve，最多 ms（默认 DISCONNECT_PUSH_MS）。
 * load、env、ms 只给测试换（模拟下载失败、一直不回，换兜底的环境）
 */
export async function disconnectPushLazy(
  load: () => Promise<PushModule> = () => import('./push.ts'),
  env: FallbackEnv = {},
  ms: number = DISCONNECT_PUSH_MS,
): Promise<void> {
  forgetPushClaim();
  const deadline = Date.now() + ms;
  const left = (): number => Math.max(0, deadline - Date.now());
  const got = await within(load, Math.min(LOAD_PUSH_MS, ms));
  if (got.kind === 'ok') {
    const done = await within(() => got.value.disconnectBrowserPush({}, left()), left());
    if (done.kind === 'fail') report('error', done.error);
    else if (done.kind === 'timeout') report('timeout', null);
    return;
  }
  if (got.kind === 'fail') report('load', got.error);
  else report('timeout', null);
  const fb = await within(() => fallbackDisconnect(env), left());
  if (fb.kind === 'fail') report('fallback', fb.error);
  else if (fb.kind === 'timeout') report('fallback', null);
}
