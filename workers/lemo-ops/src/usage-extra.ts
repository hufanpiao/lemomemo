// lemo-ops 每天用量检查里 items 之外的两件事（B7a；usage-report/usage.ts 的返回体）：
//   • unreadable：这一轮读不到的项（数据库、R2 列桶或 Cloudflare 分析接口出错、超时）——报“有几项用量读不到”，
//     那几项已有的“超过提醒线”状态原样留着（不能因为读不到就发“已恢复”，和孤儿账号、发信量同一个做法）；
//   • export_capped：昨天或今天（UTC）导出分片到每天上限的账号数（架构 0.47 第 19 条 Q6），大于 0 提醒；
//   • backup_missing：首尔今天该有服务器备份却没有 _manifest 的账号数（B7a 评审第 11 条），大于 0 提醒；
//     读不到（null，进了 unreadable）时这一项已有的状态原样留着，同 export_capped。
// 只做纯计算；evaluateUsage（rules.ts）判 items，这里把两边合成一份 Evaluation，去重和发信在 alerts.ts。
import { evaluateUsage, USAGE_LINES, type Evaluation, type UsageItem } from './rules.ts';
import { isCount, isObj } from './guards.ts';

export const USAGE_UNREADABLE = 'usage:unreadable';
export const USAGE_EXPORT_CAPPED = 'usage:export_capped';
export const USAGE_BACKUP_MISSING = 'usage:backup_missing';

/** 返回体的 unreadable：[{key, label}]；形状不对的项跳过（不让整份当成“用量查询失败”） */
export function parseUnreadable(body: unknown): { key: string; label: string }[] {
  const u = isObj(body) ? body['unreadable'] : undefined;
  if (!Array.isArray(u)) return [];
  return u.flatMap((x) => (isObj(x) && typeof x['key'] === 'string' && typeof x['label'] === 'string' ? [{ key: x['key'], label: x['label'] }] : []));
}

export function evaluateUsageReport(body: unknown, items: readonly UsageItem[]): Evaluation {
  const base = evaluateUsage(items);
  const unreadable = parseUnreadable(body);
  const capped = isObj(body) ? body['export_capped'] : undefined;
  const missing = isObj(body) ? body['backup_missing'] : undefined;
  const active = [...base.active];

  if (unreadable.length > 0) {
    active.push({
      key: USAGE_UNREADABLE,
      // 标题不带项名、个数（每天可能不一样，带进标题会被当成“情况有变”反复发）
      title: '有几项用量读不到',
      lines: [`这一轮读不到：${unreadable.map((x) => x.label).join('、')}。这几项的提醒线暂时失效，其他项照常判。`, '请看 usage-report 的函数日志（stats:、r2_bytes:、r2_ops:、backup_missing: 开头的错误码）。'],
    });
  }
  if (isCount(missing) && missing > 0) {
    active.push({
      key: USAGE_BACKUP_MISSING,
      title: '今天有账号没有服务器备份',
      lines: [
        `首尔今天有 ${missing} 个账号没有做完服务器备份（00:30 的定时备份和 02:30 的补跑之后，backups 桶里还没有当天的 _manifest）。`,
        '请看 backup-daily 的函数日志（rate_limited、time_budget、store_error、running 等）和 cron.job_run_details；不回账号是谁。',
      ],
    });
  }
  if (isCount(capped) && capped > 0) {
    active.push({
      key: USAGE_EXPORT_CAPPED,
      title: '有账号当天导出分片到上限',
      lines: [`昨天或今天（UTC）有 ${capped} 个账号的导出分片数到了每天上限，可能是数据很多的账号一天导不完，也可能有人反复导出。`, '不回账号是谁；要查到 SQL Editor 看 private.counters 里 export-part: 开头的行。'],
    });
  }

  // 都读到了：照旧整组 'usage:' 都算查过。有读不到的：只把读到的项算查过，读不到那几项的状态原样留着
  if (unreadable.length === 0 && isCount(capped) && isCount(missing)) return { active, scopes: base.scopes };
  const skip = new Set(unreadable.map((x) => x.key));
  const known = new Set([...items.map((i) => i.key), ...Object.keys(USAGE_LINES)]);
  const scopes = ['usage-call', USAGE_UNREADABLE, ...[...known].filter((k) => !skip.has(k)).map((k) => `usage:${k}`)];
  if (isCount(capped)) scopes.push(USAGE_EXPORT_CAPPED);
  if (isCount(missing)) scopes.push(USAGE_BACKUP_MISSING);
  return { active, scopes };
}
