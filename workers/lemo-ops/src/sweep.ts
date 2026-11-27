// lemo-ops 里 storage-sweep 心跳 detail 的提示（B7a 评审第 10 条、收口第 2 条）：
// usage-report 按 DETAIL_FIELDS_BY_NAME['storage-sweep'] 白名单转发 budget_hit、cap_hit、buckets_done、backup_budget_hit、backup_cap_hit
// （只是个数和布尔，没有任何文件名、账号标识）。
// 口径（storage-sweep/core.ts 文件头）：一天跑一轮，先删过期的服务器备份，再清四个 R2 桶（每天从不同的桶开始）；
//   • budget_hit：R2 那一段时间预算到了、停在半路（后面的桶这一轮没列）；
//   • cap_hit：R2 那一段判成要删的到了一轮上限，余下的只列不删；
//   • backup_budget_hit、backup_cap_hit：服务器备份那一步时间或个数到了，余下的过期日期明天接着删。
// 几件事都不算“停了”（心跳照写），但连着出现说明清理赶不上，所以当天就提示一次；心跳留到第二天那一轮，期间 lemo-ops 每 15 分钟看到的是同一份。
// 只做纯计算；rules.ts 的 evaluateHeartbeat 调这里，去重和发信在 alerts.ts。
import type { Issue } from './rules.ts';
import { isCount, isObj } from './guards.ts';

export const SWEEP_INCOMPLETE = 'sweep:incomplete';

export function evaluateSweepDetail(detail: unknown): Issue[] {
  if (!isObj(detail)) return [];
  const budget = detail['budget_hit'] === true;
  const cap = detail['cap_hit'] === true;
  const backup = detail['backup_budget_hit'] === true || detail['backup_cap_hit'] === true;
  if (!budget && !cap && !backup) return [];
  const done = detail['buckets_done'];
  const lines: string[] = [];
  if (budget) lines.push(`storage-sweep 最近一轮时间预算到了，只列完 ${isCount(done) ? done : '?'} 个桶；明天从下一个桶开始，几天内都会轮到。`);
  if (cap) lines.push('storage-sweep 最近一轮要删的文件到了一轮上限，余下的只列没删，明天接着删。');
  if (backup) lines.push('storage-sweep 最近一轮删过期服务器备份时时间或个数到了上限，余下的过期日期明天接着删。');
  lines.push('偶尔一次不要紧；连着几天都这样，说明过期或孤儿文件堆得比清得快，请看函数日志、R2 和 Storage 用量。');
  // 标题不带个数（个数变了不算“情况有变”反复发信，同 purge-detail.ts）
  return [{ key: SWEEP_INCOMPLETE, title: '文件清理一轮没做完', lines }];
}
