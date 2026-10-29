// 直接 fetch 的统一封装（架构 0.27 第 1 点）：和 supabase-js 一样带 X-App-Version
// fetch 只准出现在 platform（A12）；功能要直接调函数时走这里，不自己 fetch
import { clock } from './clock.ts';
import { buildInfo } from './env.ts';

export const APP_VERSION_HEADER = 'X-App-Version';

/** 给请求头补上 X-App-Version（调用方传了同名头时以本函数为准，不让人改版本号） */
export function withAppVersion(init: HeadersInit | undefined, version: string = buildInfo.version): Headers {
  const h = new Headers(init);
  h.set(APP_VERSION_HEADER, version);
  return h;
}

/** 426 响应体（转发层 functions/sb/version-gate.ts 和函数的第二道检查，0.27 第 1 点）：{"code":"upgrade_required","min":"4.1.0"} */
export interface UpgradeRequired {
  code: 'upgrade_required';
  /** 服务器要求的最低版本；响应体里没有或格式不对时为 null */
  min: string | null;
}

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * 读出“要求升级”：状态 426，或 4xx 的 JSON 体里 code = upgrade_required。不是就返回 null。
 * 用 clone() 读，不影响调用方再读响应体
 */
export async function readUpgradeRequired(res: Response): Promise<UpgradeRequired | null> {
  const is426 = res.status === 426;
  const json = (res.headers.get('content-type') ?? '').includes('json');
  if (!is426 && !(res.status >= 400 && res.status < 500 && json)) return null;
  let body: unknown = null;
  try {
    body = await res.clone().json();
  } catch {
    body = null;
  }
  const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (!is426 && o['code'] !== 'upgrade_required') return null;
  const min = typeof o['min'] === 'string' && VERSION_RE.test(o['min']) ? o['min'] : null;
  return { code: 'upgrade_required', min };
}

type UpgradeListener = (u: UpgradeRequired) => void;
const upgradeListeners = new Set<UpgradeListener>();

/**
 * 订阅“服务器要求升级”：经 appFetch 发出的请求（含 supabase-js 的 REST、Storage、Functions）收到 426 时通知。
 * core/boot.ts 接到 core/upgrade.ts（挡同步、出横幅）。返回取消函数
 */
export function onUpgradeRequired(fn: UpgradeListener): () => void {
  upgradeListeners.add(fn);
  return () => {
    upgradeListeners.delete(fn);
  };
}

/** 时钟偏差的样本（架构 4.3、TC-B1-31）：/sb/ 的响应读 Date 头喂给 clock；出错不影响请求 */
function observeClock(input: RequestInfo | URL, res: Response): void {
  try {
    const url = res.url || (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    clock.observeResponse(url, res.headers.get('Date'));
  } catch {
    // 读不到就跳过
  }
}

/** 带版本头的 fetch；supabase-js 的 global.fetch 也用它。426 时通知 onUpgradeRequired 的订阅者（响应原样返回） */
export async function appFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = withAppVersion(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const res = await fetch(input, { ...init, headers });
  observeClock(input, res);
  if (res.status === 426 || (res.status >= 400 && res.status < 500 && upgradeListeners.size > 0)) {
    const u = await readUpgradeRequired(res);
    if (u) for (const l of [...upgradeListeners]) l(u);
  }
  return res;
}
