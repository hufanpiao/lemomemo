// 会话丢失的原因码 lemo.authloss 和本机算的哈希（架构 4.1a 第 1、3 点；R-382，0.59 安全审 M4、0.60 复审建议 5）
// 从 auth-loss-store.ts 拆出来（首屏只要 lemo.reauth 那几个函数；这里随 core/auth-loss.ts 懒加载，main.tsx 上传时也是动态引入）
// • lemo.authloss：最多 AUTH_LOSS_MAX（5）条（旧的挤掉），每条 30 天；字段只有
//   {uid_h, path, code, status, fate, at, app}。uid_h = sha256(install_id ':' user_id) 的十六进制前 16 位（0.60 加盐），不存明文 user_id。
//   被动清库（core/account.ts 的 wipeLocal、冷启动删库）不删它；K9 自己退出、登录页“清除这台设备上的内容”删它（clearAuthLoss）
// • pairHash(session_id, user_id)：sha256(session_id ':' user_id) 的 64 位小写十六进制，在本机算（crypto.subtle），查 session_fate 用；
//   和迁移 20261111120000 的 private.session_pair_hash（uuid::text 小写）同一口径
// 首屏块里的模块一个都不 import（env.ts 在所有块共用的 jsx-runtime 块里，不算）：懒加载块一引首屏模块，
// 构建就把首屏共享块按“谁引用”拆成两块，首屏多一百多字节（R-382 首屏净增，11-11 实测）。所以 install_id 由调用方传进来，
// 下面几个常量在 auth-loss-store.ts、supabase/refresh-failure.ts 里各有一份同值的，platform/__tests__/auth-loss-store.test.ts 断言两边一致
import { buildInfo } from './env.ts';

export const AUTH_LOSS_KEY = 'lemo.authloss';
export const AUTH_LOSS_MAX = 5;
/** 和 supabase/refresh-failure.ts 的 AUTH_CODE_RE 同值 */
export const AUTH_CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** 和 auth-loss-store.ts 的 REAUTH_TTL_MS、FUTURE_SKEW_MS 同值：条目 30 天有效，比本机晚 1 天以上无效 */
export const AUTH_LOSS_TTL_MS = 30 * 24 * 3600_000;
export const AUTH_LOSS_SKEW_MS = 24 * 3600_000;

function freshAt(at: unknown, now: number): at is number {
  return typeof at === 'number' && Number.isFinite(at) && now - at < AUTH_LOSS_TTL_MS && at - now <= AUTH_LOSS_SKEW_MS;
}

/** 和 auth-loss-store.ts 的 clearAuthLoss 同一件事 */
export function clearAuthLoss(storage?: Storage): void {
  try {
    store(storage).removeItem(AUTH_LOSS_KEY);
  } catch {
    // 读不了 localStorage：没什么可删
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATHS = ['sdk', 'sync', 'outbox', 'files', 'settings', 'consent'] as const;
const FATES = ['expired', 'revoked', 'unknown', 'unchecked'] as const;

export type AuthLossPath = (typeof PATHS)[number];
export type AuthLossFate = (typeof FATES)[number];

export interface AuthLossEntry {
  uid_h: string;
  path: AuthLossPath;
  code: string;
  status: number;
  fate: AuthLossFate;
  at: number;
  app: string;
}

function store(s?: Storage): Storage {
  return s ?? localStorage;
}

/** 码只收白名单格式，否则 'unparsable' */
export function safeCode(code: unknown): string {
  return typeof code === 'string' && AUTH_CODE_RE.test(code) ? code : 'unparsable';
}

// ───────── 哈希 ─────────

async function sha256Hex(text: string): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const buf = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text)));
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** session_fate 的参数：两个 uuid 都要合法，按小写拼；算不出为 null（调用方按“查不了”） */
export async function pairHash(sessionId: string, userId: string): Promise<string | null> {
  if (!UUID_RE.test(sessionId) || !UUID_RE.test(userId)) return null;
  return sha256Hex(`${sessionId.toLowerCase()}:${userId.toLowerCase()}`);
}

/** uid_h：sha256(install_id ':' user_id) 前 16 位；install_id 读不到为 null（不记） */
export async function uidHash(userId: string, installId: string | null): Promise<string | null> {
  if (!installId || !UUID_RE.test(userId)) return null;
  const h = await sha256Hex(`${installId}:${userId.toLowerCase()}`);
  return h ? h.slice(0, 16) : null;
}

// ───────── lemo.authloss ─────────

function validEntry(e: unknown, now: number): e is AuthLossEntry {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o['uid_h'] === 'string' && /^[0-9a-f]{16}$/.test(o['uid_h']) &&
    PATHS.some((p) => p === o['path']) &&
    typeof o['code'] === 'string' && (AUTH_CODE_RE.test(o['code']) || o['code'] === 'unparsable') &&
    typeof o['status'] === 'number' && Number.isInteger(o['status']) &&
    FATES.some((f) => f === o['fate']) &&
    freshAt(o['at'], now) &&
    typeof o['app'] === 'string' && o['app'].length <= 32
  );
}

/** 只留这几个字段（写进去、读出来都过一遍，多出来的字段不留） */
function pick(e: AuthLossEntry): AuthLossEntry {
  return { uid_h: e.uid_h, path: e.path, code: e.code, status: e.status, fate: e.fate, at: e.at, app: e.app };
}

/** 读全部还算数的条目（过期、未来 1 天以上、格式不对的丢掉） */
export function readAuthLoss(now: number = Date.now(), storage?: Storage): AuthLossEntry[] {
  try {
    const raw = store(storage).getItem(AUTH_LOSS_KEY);
    if (raw === null) return [];
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((e): e is AuthLossEntry => validEntry(e, now)).map(pick) : [];
  } catch {
    return [];
  }
}

export interface AuthLossInput {
  userId: string;
  path: AuthLossPath;
  code: string | null | undefined;
  status?: number;
  fate: AuthLossFate;
  now?: number;
  app?: string;
  /** 本机 install_id（device-info.ts 的 readInstallId，调用方传）；null 不记 */
  installId: string | null;
}

/** 记一条（最多 AUTH_LOSS_MAX 条，旧的挤掉）；算不出 uid_h、存不进都不抛，返回记没记上 */
export async function pushAuthLoss(i: AuthLossInput, storage?: Storage): Promise<boolean> {
  const uid = await uidHash(i.userId, i.installId);
  if (!uid) return false;
  const now = i.now ?? Date.now();
  const status = typeof i.status === 'number' && Number.isFinite(i.status) && i.status >= 0 && i.status <= 999 ? Math.trunc(i.status) : 0;
  const entry: AuthLossEntry = {
    uid_h: uid, path: i.path, code: i.code ? safeCode(i.code) : 'none', status, fate: i.fate, at: now,
    app: (i.app ?? buildInfo.version).slice(0, 32),
  };
  try {
    const list = [...readAuthLoss(now, storage), entry].slice(-AUTH_LOSS_MAX);
    store(storage).setItem(AUTH_LOSS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/**
 * 登录以后取本账号的几条（按 uid_h 匹配），然后整个键删掉：别的账号的、对不上的（install_id 变了）直接丢，不上传（4.1a 第 3 点）
 */
export async function takeAuthLossFor(userId: string, installId: string | null, now: number = Date.now(), storage?: Storage): Promise<AuthLossEntry[]> {
  const list = readAuthLoss(now, storage);
  let mine: AuthLossEntry[] = [];
  if (list.length > 0) {
    const uid = await uidHash(userId, installId);
    mine = uid ? list.filter((e) => e.uid_h === uid) : [];
  }
  clearAuthLoss(storage);
  return mine;
}


/** 上传用的 code：<path>:<code>:<status>:<fate>（最长 8 + 40 + 3 + 9 + 3 = 63，日志 code 上限 64） */
export function authLossLogCode(e: AuthLossEntry): string {
  return `${e.path}:${e.code}:${e.status}:${e.fate}`;
}
