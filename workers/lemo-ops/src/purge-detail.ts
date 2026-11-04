// lemo-ops 里 account-purge 相关的规则（从 rules.ts 拆出，免得超 300 行）：冷静期中的账号两条（purge:overdue、purge:stuck，原样挪来），
// 加上读 account-purge 心跳 detail 的三条提示（接手清单 PURGE-heartbeat-ops；架构 0.29 续第 137 条⑦）：
// usage-report 按 DETAIL_FIELDS_BY_NAME['account-purge'] 白名单转发 account-purge 心跳里的 held、remaining、forced、blocked（只是个数，没有任何账号标识）。
// 只做纯计算；rules.ts 的 evaluateHeartbeat 调这里，去重、宽限期和发信在 alerts.ts。
//
// 口径（account-purge/core.ts 的心跳注释）：心跳只记**最近一轮**（一天 9 轮：首尔 03:30，03:45～05:30 每 15 分钟）的数，
// 最后一轮写的值一直留到第二天 03:30；lemo-ops 每 15 分钟抽一次。
//   • held：到期了、这一轮没删的——没收到删除前提醒（补发一直失败）或这一轮刚提醒过。> 0 就提示（当天）。
//   • remaining = deferred + failed + held：这一轮列出的到期账号里没做成、下一轮还会再看的个数。偶尔 > 0 是正常的
//     （预算停手留给 15 分钟后的补跑），所以要**连续 26 小时**都 > 0 才提示：盖住第二天整段运行时间（03:30～05:30），
//     也就是连着两天的运行都没清到 0（“连续 2 天”）。中间只要有一轮抽到 0 就重新算。
//   • forced：这一轮照删了没收到删除前提醒的账号（到期满 3 天补发仍失败，或 Auth 里没有邮箱）。> 0 就提示（当天），
//     要人看一眼发信是否正常。它是“这一轮发生了”的数，下一轮（15 分钟后）通常就回到 0，所以这件事随后会报“已恢复”；
//     lemo-ops 每 15 分钟只抽一次，和 account-purge 的运行刚好错开时可能抽不到某一轮（同推送失败比例的抽样局限），
//     漏看的那一次在函数日志 purge_forced_no_notice、purge_no_email_no_notice 里还在。
//   • blocked（PURGE-halfway-flip）：到期、认领到了，但再核对不过（在 admins 里，或 profile 不再是停用）的个数。正规函数走不到这里，
//     只有手工改了 admins 或 profiles 才会出现；这种账号可能已经删了一半（R2、部分备份），没人收尾就一直停在半截。> 0 就提示（当天）。
//     它每一轮都会再碰到、再算进来，所以不像 forced 那样随后“已恢复”，要人处理（删完或恢复）之后才回到 0。
// 标题不带个数（个数变了不算“情况有变”反复发信，同 orphans.ts）；正文只写个数，不写 user_id、邮箱。
import type { Issue, PendingDeletionItem } from './rules.ts';
import { fmtAge } from './stamp.ts';

const HOUR = 3600;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export const PURGE_HELD = 'purge:held';
export const PURGE_REMAINING = 'purge:remaining';
export const PURGE_FORCED = 'purge:forced';
export const PURGE_BLOCKED = 'purge:blocked';
/** remaining 连续多久 > 0 才提示：26 小时（lemo-ops 15 分钟一轮，104 轮） */
export const PURGE_REMAINING_ROUNDS = (26 * 60) / 15;

/** 冷静期到期超过 1 天还没开始删（0.29 续第 143 条；TC-B1-102 ③） */
export const PURGE_OVERDUE_S = 24 * HOUR;
/** 认领了（purge_started_at）超过 26 小时还没删完（0.29 续第 143 条；TC-B1-102 ⑤） */
export const PURGE_STUCK_S = 26 * HOUR;

/** 冷静期中的账号两条（usage-report 的 pending_deletions；原在 rules.ts 的 evaluateHeartbeat 里，PURGE-heartbeat-ops 时挪过来，行为不变） */
export function evaluatePurgePending(pending: readonly PendingDeletionItem[]): Issue[] {
  const out: Issue[] = [];
  const overdue = pending.filter((p) => p.purge_started_at === null && p.overdue_s > PURGE_OVERDUE_S);
  if (overdue.length > 0) {
    const worst = Math.max(...overdue.map((p) => p.overdue_s));
    out.push({
      key: 'purge:overdue',
      title: '注销冷静期已满、超过 1 天还没删除',
      lines: [
        `有 ${overdue.length} 个账号 purge_after 已过 1 天以上还没开始删，最久的过了 ${fmtAge(worst)}。`,
        '请看 account-purge 的 cron 是否停了、函数日志里的错误码；也可能是 skip_admin、skip_not_disabled（账号被手工设成管理员或解除了停用，见“注销删除被手工改动挡住”的提示）。',
      ],
    });
  }
  const stuck = pending.filter((p) => p.started_age_s !== null && p.started_age_s > PURGE_STUCK_S);
  if (stuck.length > 0) {
    out.push({
      key: 'purge:stuck',
      title: '注销删除认领了没删完',
      lines: [`有 ${stuck.length} 个账号 purge_started_at 超过 26 小时还在：${stuck.map((p) => p.purge_started_at ?? '').join('、')}。`, 'usage-report 的“冷静期中的账号”里能看到这几行。'],
    });
  }
  return out;
}

/** account-purge 心跳 detail 的三条提示；detail 不是对象、字段缺或不是非负整数的，那一条就不判 */
export function evaluatePurgeDetail(detail: unknown): Issue[] {
  if (!isObj(detail)) return [];
  const out: Issue[] = [];
  const held = detail['held'];
  const remaining = detail['remaining'];
  const forced = detail['forced'];
  const blocked = detail['blocked'];
  if (isCount(held) && held > 0) {
    out.push({
      key: PURGE_HELD,
      title: '有到期的注销账号没收到删除前提醒、暂未删除',
      lines: [
        `account-purge 最近一轮有 ${held} 个到期账号没删：没收到删除前提醒（补发信一直发不出去），或这一轮刚提醒过、下一轮再删。`,
        '没收到提醒的每轮会再补发；从到期起满 3 天还是发不出去就照删（会另有“没收到提醒就被删除”的提示）。',
        '请看发信是否正常（Resend 钥匙、当天额度、退信），以及函数日志里的 remind_mail_failed、purge_held_no_notice。',
      ],
    });
  }
  if (isCount(remaining) && remaining > 0) {
    out.push({
      key: PURGE_REMAINING,
      title: '注销删除连续两天有没做完的账号',
      lines: [
        `account-purge 最近一轮还有 ${remaining} 个到期账号没做成（预算停手、出错、或没收到提醒），而且已经连续 26 小时以上都不为 0。`,
        '偶尔不为 0 是正常的（留给 15 分钟后的补跑）；连着两天的运行都没清掉，说明删号在积压或有账号一直失败。',
        '请看函数日志里的 time_budget、purge_held_no_notice 和各步骤的错误码；usage-report 的“冷静期中的账号”里能看到到期的行。',
      ],
      minRounds: PURGE_REMAINING_ROUNDS,
    });
  }
  if (isCount(forced) && forced > 0) {
    out.push({
      key: PURGE_FORCED,
      title: '有注销账号没收到删除前提醒就被删除了',
      lines: [
        `account-purge 最近一轮照删了 ${forced} 个没收到删除前提醒的账号（到期满 3 天补发仍发不出去，或账号没有邮箱）。`,
        '这是负责人定的规则（等 3 天后照删），数据已经删了；要人看一眼发信是否正常：Resend 钥匙、当天额度、退信。',
        '函数日志里的 purge_forced_no_notice、purge_no_email_no_notice 是这几个账号（只有 user_id 前 8 位）。',
      ],
    });
  }
  if (isCount(blocked) && blocked > 0) {
    out.push({
      key: PURGE_BLOCKED,
      title: '注销删除被手工改动挡住、可能停在半截',
      lines: [
        `account-purge 最近一轮有 ${blocked} 个到期账号认领后再核对不过：被加进了管理员名单，或 profile 不再是停用状态。`,
        '正规的停用、解除停用、恢复都不会这样，多半是在 SQL 编辑器里手工改了 admins 或 profiles；这种账号可能已经删了一半（R2、部分备份）。',
        '请看函数日志里的 skip_admin、skip_not_disabled（只有 user_id 前 8 位），确认后把它删完或恢复；处理完之前每一轮都会再算进来。',
        '这些账号到期满 1 天后，也会算进“注销冷静期已满、超过 1 天还没删除”那条提示；那条的个数比这里多的，多出来的是别的原因。',
      ],
    });
  }
  return out;
}
