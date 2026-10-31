// lemo-ops 的“没有 profile 的 auth 用户”规则（接手清单 ORPHAN-alert；架构 0.38 第 29 条）。从 rules.ts 拆出（免得超 300 行）：
// usage-report {part: heartbeat} 返回体的 orphan_users（读 private.orphan_auth_users()，迁移 20261031160000）的校验和判断。
// 只做纯计算；rules.ts 的 parseHeartbeatReport、evaluateHeartbeat 调这里，去重和发信在 alerts.ts。
import type { Evaluation, Issue } from './rules.ts';
import { fmtAge } from './stamp.ts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** 没有 profile 的 auth 用户（ORPHAN-alert；usage-report 读 private.orphan_auth_users()，迁移 20261031160000） */
export interface OrphanReport {
  /** 建号超过 10 分钟、public.profiles 没有行的 auth 用户数 */
  count: number;
  /** 最近一个距今多少秒；没有孤儿时为 null */
  latest_age_s: number | null;
}

/** 形状不对（个数不是非负整数、有孤儿却没有时刻、时刻不是数）只降级成 null（报“读不到”），不让整份返回体判为解析不了 */
export function parseOrphans(o: unknown): OrphanReport | null {
  if (!isObj(o) || !isCount(o['count'])) return null;
  const age = o['latest_age_s'];
  if (age === null || age === undefined) return o['count'] === 0 ? { count: 0, latest_age_s: null } : null;
  return isNum(age) ? { count: o['count'], latest_age_s: age } : null;
}

/** 孤儿用户的两件事；usage-report 不带 orphan_users（没接）时整组悄悄删掉 */
export const SCOPE_ORPHAN = 'orphan:';
export const ORPHAN_USERS = 'orphan:users';
export const ORPHAN_UNREADABLE = 'orphan:unreadable';

/**
 * 没有 profile 的 auth 用户（ORPHAN-alert；架构 0.38 第 29 条）：大于 0 就告警。
 * 标题不带个数（个数变了不算“情况有变”反复发；去重和冷却照 alerts.ts 的通用做法：同一个 key 6 小时内只发一次，消失后发“已恢复”）。
 * 读不到的那一轮只查“读不到”这一件，orphan:users 的状态原样留着（不能因为读不到就报“已恢复”）——和发信量同一个做法。
 * 正文只写个数和最近一个距今多久，不写 id、邮箱；核对办法在上线与回滚手册第八节（同 invite-signup/core.ts 里 orphan_suspect 处的注释）。
 */
export function evaluateOrphans(o: OrphanReport | null): Evaluation {
  if (o === null) {
    return {
      active: [{ key: ORPHAN_UNREADABLE, title: '没有资料的账号数读不到', lines: ['usage-report 这一轮没读到“没有 profile 的 auth 用户”数，这项告警暂时失效。', '心跳等其他检查不受影响；请看 usage-report 的函数日志（orphans:error、orphans:timeout 或 orphans:bad_data）。'] }],
      scopes: [ORPHAN_UNREADABLE],
    };
  }
  const active: Issue[] = [];
  if (o.count > 0) {
    active.push({
      key: ORPHAN_USERS,
      title: '有注册到一半的账号（auth 里有、没有资料）',
      lines: [
        `现在有 ${o.count} 个 auth 用户建号超过 10 分钟仍没有 profile${o.latest_age_s === null ? '' : `，最近一个建于 ${fmtAge(o.latest_age_s)}前`}。`,
        '多半是邀请注册中途出错留下的（invite-signup 日志 orphan_user 或 orphan_suspect）；这些账号用不了（能收到验证码，进去没有资料），占用的那一次邀请码不会自动退回。',
        '核对和处理办法见上线与回滚手册第八节：SQL Editor 查出这几个用户，在 Authentication → Users 删掉，再用 invite-admin 给本人重发邀请码。',
      ],
    });
  }
  return { active, scopes: [ORPHAN_UNREADABLE, ORPHAN_USERS] };
}
