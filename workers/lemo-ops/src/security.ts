// lemo-ops 的安全计数规则（R-382 复审建议 3，架构 6.1）：usage-report {part: heartbeat} 返回体的 security_events
// （读 private.security_events()：最近 15 分钟 sfate-capped、pwrevoke-fail 两个计数，迁移 20261111120000）的校验和判断。
// 只做纯计算；rules.ts 调这里，去重和发信在 alerts.ts。读不到时只报“读不到”，原来两件的状态留着（同 orphans.ts）。
import type { Evaluation, Issue } from './rules.ts';
import { isCount, isObj } from './guards.ts';

export interface SecurityReport {
  /** 最近 15 分钟 session_fate 撞上全库每分钟 600 次总闸的分钟数 */
  sfate_capped: number;
  /** 最近 15 分钟改密码触发器吊销会话出错的次数 */
  pw_revoke_failed: number;
}

/** 形状不对只降级成 null（报“读不到”），不让整份返回体判为解析不了 */
export function parseSecurity(o: unknown): SecurityReport | null {
  if (!isObj(o) || !isCount(o['sfate_capped']) || !isCount(o['pw_revoke_failed'])) return null;
  return { sfate_capped: o['sfate_capped'], pw_revoke_failed: o['pw_revoke_failed'] };
}

export const SCOPE_SECURITY = 'security:';
export const SECURITY_SFATE = 'security:sfate-capped';
export const SECURITY_PWREVOKE = 'security:pwrevoke-fail';
export const SECURITY_UNREADABLE = 'security:unreadable';

/** 任一计数大于 0 就告警；标题不带个数（个数变了不算情况有变）；正文不带账号标识 */
export function evaluateSecurity(s: SecurityReport | null): Evaluation {
  if (s === null) {
    return {
      active: [{ key: SECURITY_UNREADABLE, title: '安全计数读不到', lines: ['usage-report 这一轮没读到 private.security_events()，session_fate 总闸和改密码吊销的告警暂时失效。', '请看 usage-report 的函数日志（security:error、security:timeout 或 security:bad_data）。'] }],
      scopes: [SECURITY_UNREADABLE],
    };
  }
  const active: Issue[] = [];
  if (s.sfate_capped > 0) {
    active.push({ key: SECURITY_SFATE, title: '会话下场查询撞上全库总闸', lines: [
      `最近 15 分钟有 ${s.sfate_capped} 分钟 public.session_fate 超过每分钟 600 次，超出的一律回 unknown（被移除的设备会被当成登录过期、不清本机）。`,
      '多半是有人在刷这个不登录可调的接口：到 Cloudflare 控制台看 /sb/rest/v1/rpc/session_fate 的来源 IP，按 IP 限流。',
    ] });
  }
  if (s.pw_revoke_failed > 0) {
    active.push({ key: SECURITY_PWREVOKE, title: '改密码后没能吊销旧会话', lines: [
      `最近 15 分钟改密码触发器出错 ${s.pw_revoke_failed} 次：密码照常改了，但旧会话没写进吊销记录。`,
      '请看数据库日志里 private.on_password_change 的报错。',
    ] });
  }
  return { active, scopes: [SECURITY_UNREADABLE, SECURITY_SFATE, SECURITY_PWREVOKE] };
}
