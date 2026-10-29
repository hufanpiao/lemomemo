// 设置 › 账号 › 最近的导出（R-256 ②④；架构 0.29 续第 96 条③、续第 126 条；数据字典 4.6 logs）
// • 怎么读：logs 的 RLS 给本人 select（0001_core.sql：policy sel，grant select to authenticated），account 函数没有列导出记录的 action，
//   所以直接经 PostgREST 读本人的 logs 行（supabase-js 的 from('logs')，不另拉依赖；设置页本来就是懒加载分包）。
//   不走 account-api 的 send()：那是 POST account 函数的，服务器上没有对应的动作，supabase/ 这批也不能改
// • 只读 src = 'account'、kind = 'run'、act 为 export 或 export_mail_failed、最近 90 天（logs 保留期，客户端也按 90 天过滤）的行，
//   按 t 倒序最多 RECENT_EXPORT_LIMIT 条：export 每天最多 3 次，90 天最多 270 条，加上同样多的 export_mail_failed，540 条一定够
// • 配对（数据字典 4.6，10-30 起）：export_mail_failed 行的 code = 对应 export 行 t 的 ISO 字符串，两行按 device + code 配对
//   （user_id 由 RLS 保证是本人）。列出 90 天里全部 export（架构 0.29 续第 96 条③），按时间倒序；
//   配上 export_mail_failed 的那几条标“通知邮件没发出去”。设备名不另查 devices，由界面用设置页已读到的设备列表对上
// • 时间在将来的行（t > 现在 + RECENT_EXPORT_FUTURE_SKEW_MS，export 和 export_mail_failed 都算）查询时就不要、读回来再丢一遍：
//   本人的 logs 行能伪造（R-259），防的是伪造未来时间的行占满 600 条上限、把真记录挤出去。这只是减轻措施，
//   根本的修法在服务器 R-259 迁移（不让本人随便写 logs）
// • 导出成功后读两次：立刻一次，RECENT_EXPORT_RECHECK_MS 后再一次（发信失败那行是服务器回响应以后 waitUntil 才写的）
// • 读失败、断网、超时、会话不认：一律 kind: 'hidden'，界面安静不显示、不提示；会话没了由设备列表等别的请求处理
import type { Db } from '../../../platform/supabase/client.ts';

export const RECENT_EXPORT_DAYS = 90;
export const RECENT_EXPORT_LIMIT = 600;
export const RECENT_EXPORT_TIMEOUT_MS = 8000;
/** 比现在晚这么多以上的行当伪造的丢掉（容得下几分钟的时钟误差） */
export const RECENT_EXPORT_FUTURE_SKEW_MS = 5 * 60_000;
/** 导出成功后隔这么久再读一次，等服务器补写发信失败行 */
export const RECENT_EXPORT_RECHECK_MS = 5000;
const DAY_MS = 86_400_000;

export interface ExportLogRow {
  t: number;
  device: string | null;
  act: string | null;
  code: string | null;
}

export interface ExportEntry {
  /** 那次导出的时刻（毫秒） */
  at: number;
  /** 导出时带的设备行 id（小写；没带为 null）。设备名由界面按设置页已读到的设备列表对上 */
  device: string | null;
  /** 那次的通知邮件没发出去（配上了 export_mail_failed） */
  mailFailed: boolean;
}

/** ready：按时间倒序的全部导出（至少一条）；none：90 天里没有导出记录；hidden：读不出来，不显示 */
export type RecentExportResult = { kind: 'ready'; list: ExportEntry[] } | { kind: 'none' } | { kind: 'hidden' };

const isoOf = (ms: number): string | null => {
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
};

const devKey = (d: string | null): string => (d ?? '').toLowerCase();

/**
 * 90 天里的全部导出，按时间倒序；每条配上它的发信失败行（device + code，code = 那条 export 的 t 的 ISO）。
 * since 之前的不算（服务器清理晚一天也不显示 91 天前的）；until 之后的（时间在将来，见文件头 R-259）两种行都丢掉
 */
export function listExports(rows: readonly ExportLogRow[], since: number, until = Infinity): ExportEntry[] {
  const kept = rows.filter((r) => Number.isFinite(r.t) && r.t <= until);
  const failed = new Set<string>();
  for (const r of kept) if (r.act === 'export_mail_failed' && r.code) failed.add(`${devKey(r.device)}|${r.code}`);
  const out: ExportEntry[] = [];
  for (const r of kept) {
    if (r.act !== 'export' || r.t < since) continue;
    const iso = isoOf(r.t);
    const device = r.device ? r.device.toLowerCase() : null;
    out.push({ at: r.t, device, mailFailed: iso !== null && failed.has(`${devKey(device)}|${iso}`) });
  }
  return out.sort((x, y) => y.at - x.at);
}

export interface RecentExportsApi {
  list(): Promise<RecentExportResult>;
}

type Res = PromiseLike<{ data: unknown; error: unknown }>;
/** 用到的那一小段查询链（测试换假的） */
interface LogsQuery {
  from(t: 'logs'): {
    select(cols: string): {
      eq(c: 'src', v: string): {
        eq(c: 'kind', v: string): {
          in(c: 'act', v: string[]): {
            gte(c: 't', v: number): { lte(c: 't', v: number): { order(c: 't', o: { ascending: boolean }): { limit(n: number): Res } } };
          };
        };
      };
    };
  };
}

function toRows(data: unknown): ExportLogRow[] {
  if (!Array.isArray(data)) return [];
  const out: ExportLogRow[] = [];
  for (const v of data) {
    if (typeof v !== 'object' || v === null) continue;
    const o = v as Record<string, unknown>;
    const t = typeof o['t'] === 'number' ? o['t'] : typeof o['t'] === 'string' ? Number(o['t']) : NaN;
    if (!Number.isFinite(t)) continue;
    const s = (k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null);
    out.push({ t, device: s('device'), act: s('act'), code: s('code') });
  }
  return out;
}

export function createRecentExportsApi(
  getDb: () => Promise<Db>,
  o: { now?: () => number; timeoutMs?: number } = {},
): RecentExportsApi {
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? RECENT_EXPORT_TIMEOUT_MS;
  const HIDDEN: RecentExportResult = { kind: 'hidden' };
  return {
    async list() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<RecentExportResult>((r) => {
        timer = setTimeout(() => r(HIDDEN), timeoutMs);
      });
      const run = async (): Promise<RecentExportResult> => {
        try {
          const db = (await getDb()) as unknown as LogsQuery;
          const at = now();
          const since = at - RECENT_EXPORT_DAYS * DAY_MS;
          const until = at + RECENT_EXPORT_FUTURE_SKEW_MS;
          const { data, error } = await db
            .from('logs')
            .select('t,device,act,code')
            .eq('src', 'account')
            .eq('kind', 'run')
            .in('act', ['export', 'export_mail_failed'])
            .gte('t', since)
            .lte('t', until)
            .order('t', { ascending: false })
            .limit(RECENT_EXPORT_LIMIT);
          if (error) return HIDDEN;
          const list = listExports(toRows(data), since, until);
          return list.length > 0 ? { kind: 'ready', list } : { kind: 'none' };
        } catch {
          return HIDDEN;
        }
      };
      try {
        return await Promise.race([run(), expired]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
