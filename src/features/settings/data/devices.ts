// 设置 › 已登录设备：把 devices 行整理成界面要的样子（纯函数，不联网）
// 依据：架构 0.29 续第 98、99、103、108、111 条；0.38 第 14 条
// • 本机：这一行的 session_id 等于当前令牌里的 session_id（第 99 条⑥，服务器的 is_current_device 用同一个判断）
// • 已退出：session_id 为空（第 103 条①），或在 my_sessions() 的 signed_out_device_ids 里（会话已不在、已被吊销；
//   20261029160000，0.38 第 38 条，TC-B1-79 ②）；已退出的照样能点“移除”
// • 很久没用：最后活动超过 150 天，写“<日期> 后自动移除”（180 天，第 108 条）；last_seen_at 比现在快 1 天以上的不认

export type Platform = 'ios' | 'windows' | 'web' | 'tauri';

/** 经 RLS 读到的 devices 行里设置页用得到的列 */
export interface DeviceRow {
  id: string;
  label: string | null;
  platform: string;
  last_seen_at: string | null;
  /** 0.38 第 8 条新加的列；类型文件还没重新生成时可能读不到 */
  created_at: string | null;
  session_id: string | null;
}

export interface DeviceView {
  id: string;
  /** 设备名：label 为空时按平台给一个（界面再翻译） */
  label: string | null;
  platform: Platform | 'unknown';
  isCurrent: boolean;
  signedOut: boolean;
  /** 最后活动（毫秒）；没有可信的时间为 null */
  lastActiveMs: number | null;
  /** 很久没用时“自动移除”的日期（毫秒），否则 null */
  autoRemoveAtMs: number | null;
}

const DAY = 86_400_000;
export const STALE_AFTER_MS = 150 * DAY;
export const REMOVE_AFTER_MS = 180 * DAY;

const PLATFORMS: readonly string[] = ['ios', 'windows', 'web', 'tauri'];

function ms(v: string | null): number | null {
  if (!v) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

/** 0.38 第 14 条：last_seen_at 在将来（快 1 天以上）不认；和 created_at 取较晚的 */
export function lastActive(row: Pick<DeviceRow, 'last_seen_at' | 'created_at'>, now: number): number | null {
  const seen = ms(row.last_seen_at);
  const trusted = seen !== null && seen <= now + DAY ? seen : null;
  const created = ms(row.created_at);
  if (trusted === null) return created;
  if (created === null) return trusted;
  return Math.max(trusted, created);
}

export function toDeviceView(row: DeviceRow, currentSession: string | null, now: number, signedOutIds: ReadonlySet<string> = new Set()): DeviceView {
  const last = lastActive(row, now);
  const label = row.label?.trim() ? row.label.trim() : null;
  const isCurrent = currentSession !== null && row.session_id === currentSession;
  return {
    id: row.id,
    label,
    platform: PLATFORMS.includes(row.platform) ? (row.platform as Platform) : 'unknown',
    isCurrent,
    signedOut: !isCurrent && (row.session_id === null || signedOutIds.has(row.id)),
    lastActiveMs: last,
    autoRemoveAtMs: last !== null && now - last > STALE_AFTER_MS ? last + REMOVE_AFTER_MS : null,
  };
}

/** 本机排第一，其余按最后活动从近到远，没有时间的放最后 */
export function sortDevices(list: readonly DeviceView[]): DeviceView[] {
  return [...list].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return (b.lastActiveMs ?? -Infinity) - (a.lastActiveMs ?? -Infinity);
  });
}

/** 从 access token 的 payload 里读 session_id（只用来在界面上标“本机”；真正的判断在服务器） */
export function sessionIdOfToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='))) as { session_id?: unknown };
    return typeof json.session_id === 'string' && json.session_id ? json.session_id : null;
  } catch {
    return null;
  }
}

/** my_sessions() 的一行：没有设备行的会话个数和最近时间（第 111、118 条）、已退出的设备 id（20261029160000） */
export interface Orphans {
  count: number;
  lastAtMs: number | null;
}

export interface SessionInfo {
  orphans: Orphans;
  signedOutIds: ReadonlySet<string>;
}

export function toSessionInfo(rows: unknown): SessionInfo {
  const r: unknown = Array.isArray(rows) ? rows[0] : rows;
  if (typeof r !== 'object' || r === null) return { orphans: { count: 0, lastAtMs: null }, signedOutIds: new Set() };
  const o = r as Record<string, unknown>;
  const n = typeof o['orphan_count'] === 'number' && o['orphan_count'] > 0 ? Math.floor(o['orphan_count']) : 0;
  const at = typeof o['orphan_last_at'] === 'string' ? ms(o['orphan_last_at']) : null;
  const ids = Array.isArray(o['signed_out_device_ids']) ? o['signed_out_device_ids'].filter((x): x is string => typeof x === 'string') : [];
  return {
    orphans: { count: n, lastAtMs: n > 0 ? at : null },
    signedOutIds: new Set(ids),
  };
}
