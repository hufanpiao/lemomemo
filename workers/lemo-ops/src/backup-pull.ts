// lemo-ops 里 backup-pull 心跳 detail 的提示（B7a 复审第 5 条“接近上限时让 lemo-ops 报警”）。
// 心跳由 backup-manifest 在 pull.ps1 拉完、没有失败时写（{done: true}），detail 是服务器自己数的个数（supabase/functions/backup-manifest/core.ts 文件头）：
//   accounts（最近 7 天里人数最多那天的账号数）、pull_calls / pull_limit（照现在的人数拉一遍要几次 / 每小时上限）、
//   wait_pages / wait_limit（发布前等待每轮几页 / 每小时上限）。usage-report 按 DETAIL_FIELDS_BY_NAME['backup-pull'] 白名单转发。
// 两种情况提示一次（该把 backup-manifest 的 PULL_HOURLY、WAIT_HOURLY 或 PAGE_USERS 调大了）：
//   • 拉一遍的次数超过 PULL_HOURLY 的 70%（按 PAGE_USERS 50 约 1480 个账号）；
//   • 发布前等待的间隔会被拉到 5 分钟以上：pull.ps1 的间隔 = max(120 秒, 3600 × 每轮页数 ÷ (WAIT_HOURLY × 0.8))，
//     超过 300 秒即 每轮页数 × 15 > WAIT_HOURLY（WAIT_HOURLY 600 时约 2000 个账号）；不会撞限流，只是发现“都做完了”要晚几分钟。
// “超过 26 小时没写心跳”是 rules.ts 的 HEARTBEAT_LIMITS['backup-pull']，不在这里。
// 只做纯计算；rules.ts 的 evaluateHeartbeat 调这里，去重和发信在 alerts.ts。
import type { Issue } from './rules.ts';
import { isCount, isObj } from './guards.ts';

export const BACKUP_PULL_NEAR_LIMIT = 'pull:near-limit';
/** pull.ps1 发布前等待的间隔超过这么多秒就提示 */
const WAIT_SLOW_POLL_S = 300;

export function evaluateBackupPullDetail(detail: unknown): Issue[] {
  if (!isObj(detail)) return [];
  const { accounts, pull_calls: pull, pull_limit: pullMax, wait_pages: wait, wait_limit: waitMax } = detail;
  const lines: string[] = [];
  if (isCount(pull) && isCount(pullMax) && pullMax > 0 && pull * 10 > pullMax * 7) {
    lines.push(`拉一遍备份要调 backup-manifest ${pull} 次，每小时上限 ${pullMax} 次（已超过 70%）。`);
  }
  if (isCount(wait) && isCount(waitMax) && waitMax > 0 && (3600 * wait) / (waitMax * 0.8) > WAIT_SLOW_POLL_S) {
    lines.push(`发布前等待每轮要 ${wait} 页，每小时上限 ${waitMax} 次，pull.ps1 要把间隔拉到 ${Math.ceil((3600 * wait) / (waitMax * 0.8))} 秒（超过 5 分钟）。`);
  }
  if (!lines.length) return [];
  if (isCount(accounts)) lines.unshift(`最近 7 天里一天最多 ${accounts} 个账号。`);
  lines.push('请调大 backup-manifest/core.ts 的 PULL_HOURLY、WAIT_HOURLY 或 PAGE_USERS（文件头有按账号数的算法）。');
  // 标题不带个数（个数变了不算“情况有变”反复发信，同 sweep.ts）
  return [{ key: BACKUP_PULL_NEAR_LIMIT, title: '备份拉取快到每小时上限了', lines }];
}
