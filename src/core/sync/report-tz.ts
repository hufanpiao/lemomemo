// 上报时区（架构 4.6：设备启动时、有用户操作时调 report_tz；手机优先、10 分钟防抖由服务器判断）
// • rate_limited（接手清单 K8-tz-rl，迁移 20261029192000：同一人每小时最多采纳 6 次新时区）：这次没采纳、稍后再报——
//   不当错误、不提示用户，下一个正常上报时机再报（下一小时就会采纳）
// • fixed、unchanged、phone_priority、pending、accepted 都是正常结果；pending 的那一笔要同一台设备 10 分钟内再报一次同一个新时区才采纳，
//   所以两次上报至少隔 MIN_INTERVAL_MS（5 分钟）、又不会隔太久
// • 网络错、函数报错（bad_tz、device_mismatch……）：记错误码，不提示用户，下一个时机再报；session_revoked、account_disabled 由发送循环处理
// 纯 TS：不准 import React 和任何功能（A1）
import type { SyncTransport, TzReportResult } from './types.ts';

export const TZ_MIN_INTERVAL_MS = 5 * 60 * 1000;

export type TzReportOutcome =
  /** 服务器给了结果（含 rate_limited：retryLater = true） */
  | { kind: 'reported'; result: TzReportResult; retryLater: boolean }
  /** 没报：没有本会话的设备行、不到间隔、正在报 */
  | { kind: 'skipped' }
  | { kind: 'error'; code: string };

export interface TzReporterDeps {
  transport: Pick<SyncTransport, 'reportTz'>;
  /** 本会话的 devices 行 id（登录流程登记设备后才有；没有就不报） */
  deviceId(): string | null;
  /** devices.platform：ios / windows / web / tauri */
  platform: string;
  /** 设备当前时区；默认 Intl 读 */
  currentTz?: () => string;
  now?: () => number;
  /** 记日志：失败一律 report_tz_failed，错误码放 code 列（act 最长 32 字，不拼码，0.38 第 62 条） */
  log?: (act: string, f?: { code?: string }) => void;
}

export interface TzReporter {
  /** 启动时、有用户操作时调；不到间隔就跳过。force：启动那一次不看间隔 */
  report(force?: boolean): Promise<TzReportOutcome>;
}

const intlTz = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function createTzReporter(deps: TzReporterDeps): TzReporter {
  const now = deps.now ?? (() => Date.now());
  let lastAt: number | null = null;
  let busy = false;
  return {
    async report(force = false) {
      const id = deps.deviceId();
      if (!id || busy) return { kind: 'skipped' };
      if (!force && lastAt !== null && now() - lastAt < TZ_MIN_INTERVAL_MS) return { kind: 'skipped' };
      busy = true;
      lastAt = now();
      try {
        const r = await deps.transport.reportTz((deps.currentTz ?? intlTz)(), id, deps.platform);
        if (!r.ok) {
          const code = r.error.code ?? (r.error.network ? 'network' : `http_${r.error.status ?? 0}`);
          deps.log?.('report_tz_failed', { code });
          return { kind: 'error', code };
        }
        return { kind: 'reported', result: r.value, retryLater: r.value === 'rate_limited' || r.value === 'pending' };
      } finally {
        busy = false;
      }
    },
  };
}
