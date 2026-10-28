// lemo-ops 的判断规则（架构 6.1、0.29 续第 116、143 条；TC-B1-94、TC-B1-102 ③～⑤）。
// 只做纯计算：把 usage-report 的返回变成“现在有哪些事”，不发信、不读写状态（发信和去重在 alerts.ts）。
// usage-report 只报“距今多少秒”，阈值只写在这里一处。

/** 一件要告警的事。key 用来去重：同一个 key 6 小时内只发一次，消失后发“已恢复” */
export interface Issue {
  key: string;
  /** 邮件标题里的那句话（不含前缀） */
  title: string;
  /** 邮件正文的几行：只写名字、时长、个数，不写用户内容、不写 user_id、不写 SQL */
  lines: string[];
}

/**
 * 一轮检查的结论：active 是现在还在的事；scopes 是这一轮查过的 key（以“:”结尾的按前缀；只有查过的才会判“已恢复”）；
 * drop 是这一轮起不再查的 key（同样写法），状态里有就悄悄删掉、不发“已恢复”（例如从 REQUIRED_HEARTBEATS 删掉的名字）；
 * hookHour 是收到钩子出错 alert 的 UTC 小时（yyyymmddThh），去重和重试在 alerts.ts。
 */
export interface Evaluation {
  active: Issue[];
  scopes: string[];
  drop?: string[];
  hookHour?: string;
}

// ---------- 心跳阈值（架构 6.1；单位秒） ----------

const MIN = 60;
const HOUR = 3600;

/**
 * 各 cron 函数的心跳多久没更新就告警。名字就是 private.heartbeat.name。
 * - push-dispatch 5 分钟、ai-classify 15 分钟、backup-daily 26 小时、vault-file sweep 10 分钟：架构 6.1
 * - account-purge 26 小时：0.29 续第 131 条⑤、第 143 条（TC-B1-102 ④：26 小时 1 分发，25 小时 59 分不发）
 * vault-file sweep 写心跳用的名字架构没写死，这里先按 `vault-file-sweep`，后端写 sweep 时按这个名字写（不一致就改这一处）。
 */
export const HEARTBEAT_LIMITS: Readonly<Record<string, { limitS: number; label: string }>> = {
  'push-dispatch': { limitS: 5 * MIN, label: '推送服务（push-dispatch）' },
  'ai-classify': { limitS: 15 * MIN, label: 'AI 分类（ai-classify）' },
  'backup-daily': { limitS: 26 * HOUR, label: '每日备份（backup-daily）' },
  'vault-file-sweep': { limitS: 10 * MIN, label: '隐私记预览清理（vault-file sweep）' },
  'account-purge': { limitS: 26 * HOUR, label: '注销到期删除（account-purge）' },
  // 30 天清理每天 UTC 18 点那一小时每分钟一批（0.29 续第 135 条），两天之间最多隔 23 小时
  cleanup: { limitS: 26 * HOUR, label: '30 天清理（cleanup）' },
};

/**
 * push-dispatch 写心跳时 detail 的字段（架构 6.1 末条“推送失败”，这里定下来）：{ sent: 本轮成功条数, failed: 本轮失败条数 }。
 * 一轮里失败超过一半（failed × 2 > sent + failed，且总数大于 0）就告警。usage-report 只转发白名单里的数字字段。
 */
export const PUSH_DETAIL_FIELDS = ['sent', 'failed'] as const;

/** 冷静期到期超过 1 天还没开始删（0.29 续第 143 条；TC-B1-102 ③） */
export const PURGE_OVERDUE_S = 24 * HOUR;
/** 认领了（purge_started_at）超过 26 小时还没删完（0.29 续第 143 条；TC-B1-102 ⑤） */
export const PURGE_STUCK_S = 26 * HOUR;
/** 30 天清理单批超过 2 分钟告警（0.29 续第 135 条）；只看最近 30 分钟内写的那次心跳，免得旧的一批整天重复告警 */
export const CLEANUP_SLOW_MS = 2 * MIN * 1000;
const CLEANUP_RECENT_S = 30 * MIN;

// ---------- usage-report {part: heartbeat} 的返回 ----------

export interface HeartbeatItem {
  name: string;
  age_s: number;
  detail: unknown;
}

export interface PendingDeletionItem {
  purge_after: string;
  purge_started_at: string | null;
  /** 距 purge_after 已过去多少秒（没到期是负数） */
  overdue_s: number;
  /** 距 purge_started_at 多少秒；没认领是 null */
  started_age_s: number | null;
}

export interface HeartbeatReport {
  ok: true;
  heartbeats: HeartbeatItem[];
  pending_deletions: PendingDeletionItem[];
  long_tx: number;
  /** 钩子出错告警（只在第三条路启用时由 usage-report 给出；0.29 续第 115 条）；同一小时最多一次 true，去重在服务器 */
  alert?: boolean;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 校验返回体的形状；对不上返回 null（按“返回体解析不了”算调不通，TC-B1-94 ⑤） */
export function parseHeartbeatReport(v: unknown): HeartbeatReport | null {
  if (!isObj(v) || v['ok'] !== true) return null;
  const hb = v['heartbeats'];
  const pd = v['pending_deletions'];
  const lt = v['long_tx'];
  if (!Array.isArray(hb) || !Array.isArray(pd) || !isNum(lt)) return null;
  const heartbeats: HeartbeatItem[] = [];
  for (const h of hb) {
    if (!isObj(h) || typeof h['name'] !== 'string' || !isNum(h['age_s'])) return null;
    heartbeats.push({ name: h['name'], age_s: h['age_s'], detail: h['detail'] ?? null });
  }
  const pending: PendingDeletionItem[] = [];
  for (const p of pd) {
    if (!isObj(p) || typeof p['purge_after'] !== 'string' || !isNum(p['overdue_s'])) return null;
    const started = p['purge_started_at'];
    const startedAge = p['started_age_s'];
    if (started !== null && typeof started !== 'string') return null;
    if (startedAge !== null && !isNum(startedAge)) return null;
    pending.push({ purge_after: p['purge_after'], purge_started_at: started, overdue_s: p['overdue_s'], started_age_s: startedAge });
  }
  const alert = v['alert'];
  if (alert !== undefined && typeof alert !== 'boolean') return null;
  const out: HeartbeatReport = { ok: true, heartbeats, pending_deletions: pending, long_tx: lt };
  if (alert !== undefined) out.alert = alert;
  return out;
}

/** 秒数写成“x 小时 y 分”这种给人看的样子 */
export function fmtAge(s: number): string {
  const total = Math.max(0, Math.floor(s / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h >= 48) return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

export const SCOPE_UNREACHABLE = 'unreachable';
/** 15 分钟一轮的心跳检查查过的 key 前缀（调通时） */
export const SCOPE_BAD_DATA = 'bad-data';
export const HEARTBEAT_SCOPES = [SCOPE_UNREACHABLE, SCOPE_BAD_DATA, 'hb:', 'purge:', 'longtx', 'cleanup-slow', 'push-failed'];

/**
 * 心跳轮的判断（调通 usage-report 之后）。
 * required：必须有心跳行的名字（环境变量 REQUIRED_HEARTBEATS）。没有这一行时：在名单里算“从没跑过”告警；
 * 不在名单里算“还没上线”、不查（各批的 cron 函数陆续上线，没上线的不能天天告警）。
 */
export function evaluateHeartbeat(r: HeartbeatReport, required: readonly string[]): Evaluation {
  const active: Issue[] = [];
  const drop: string[] = [];
  const byName = new Map(r.heartbeats.map((h) => [h.name, h]));

  for (const [name, rule] of Object.entries(HEARTBEAT_LIMITS)) {
    const h = byName.get(name);
    if (!h) {
      if (required.includes(name)) {
        active.push({ key: `hb:${name}`, title: `${rule.label}从没写过心跳`, lines: [`private.heartbeat 里没有 ${name} 这一行（REQUIRED_HEARTBEATS 里写了它）。`] });
      } else {
        drop.push(`hb:${name}`);   // 没上线或已从名单删掉：不查，也不报“已恢复”
      }
      continue;
    }
    if (h.age_s > rule.limitS) {
      active.push({
        key: `hb:${name}`,
        title: `${rule.label}停了`,
        lines: [`最后一次心跳在 ${fmtAge(h.age_s)}前，超过 ${fmtAge(rule.limitS)}。`],
      });
    }
  }

  const overdue = r.pending_deletions.filter((p) => p.purge_started_at === null && p.overdue_s > PURGE_OVERDUE_S);
  if (overdue.length > 0) {
    const worst = Math.max(...overdue.map((p) => p.overdue_s));
    active.push({
      key: 'purge:overdue',
      title: '注销冷静期已满、超过 1 天还没删除',
      lines: [`有 ${overdue.length} 个账号 purge_after 已过 1 天以上还没开始删，最久的过了 ${fmtAge(worst)}。`, '请看 account-purge 的 cron 是否停了、函数日志里的错误码。'],
    });
  }
  const stuck = r.pending_deletions.filter((p) => p.started_age_s !== null && p.started_age_s > PURGE_STUCK_S);
  if (stuck.length > 0) {
    active.push({
      key: 'purge:stuck',
      title: '注销删除认领了没删完',
      lines: [`有 ${stuck.length} 个账号 purge_started_at 超过 26 小时还在：${stuck.map((p) => p.purge_started_at ?? '').join('、')}。`, 'usage-report 的“冷静期中的账号”里能看到这几行。'],
    });
  }

  if (r.long_tx > 0) {
    active.push({ key: 'longtx', title: '数据库有超过 4 分钟的长事务', lines: [`现在有 ${r.long_tx} 个（private.long_transactions()）。不含 SQL 原文，请到控制台看。`] });
  }

  const cleanup = byName.get('cleanup');
  if (cleanup && cleanup.age_s <= CLEANUP_RECENT_S && isObj(cleanup.detail) && isNum(cleanup.detail['ms']) && cleanup.detail['ms'] > CLEANUP_SLOW_MS) {
    active.push({ key: 'cleanup-slow', title: '30 天清理单批超过 2 分钟', lines: [`最近一批用了 ${Math.round(cleanup.detail['ms'] / 1000)} 秒。`] });
  }

  // 推送失败比例只看心跳里最近那一轮（push-dispatch 每分钟一轮，lemo-ops 15 分钟才抽一次，中间 14 轮看不到）：
  // 这是抽样，偶发的一轮失败多半抽不到；持续失败才会被连续抽中。要看全量得让 push-dispatch 在 detail 里累计，B2 再定（K15 复审低 4）
  const push = byName.get('push-dispatch');
  if (push && isObj(push.detail) && isNum(push.detail['sent']) && isNum(push.detail['failed'])) {
    const sent = push.detail['sent'];
    const failed = push.detail['failed'];
    if (sent + failed > 0 && failed * 2 > sent + failed) {
      active.push({ key: 'push-failed', title: '推送一轮里超过一半失败', lines: [`最近一轮成功 ${sent} 条、失败 ${failed} 条。`] });
    }
  }

  return { active, scopes: HEARTBEAT_SCOPES, drop };
}

// ---------- 调不通（TC-B1-94 ①②⑤） ----------

export type UnreachableReason = 'db_unreachable' | 'bad_data' | 'timeout' | 'network' | 'bad_body' | `http_${number}`;

/** 两种调不通（连不上数据库、usage-report 本身调不通）共用一个标题，原因写在正文（审查必改 1：换原因不算新的一件事） */
export const UNREACHABLE_TITLE = '监控连不上服务器';

/** 调不通时只查得了“调不通”这一件事，其余的状态原样留着（不发“已恢复”） */
export function evaluateUnreachable(reason: UnreachableReason): Evaluation {
  // usage-report 回 500 bad_data：服务器连得上、数据库也通，只是心跳表里的时间戳解析不了。单独一件事“服务器数据异常”，
  // 不报成“连不上服务器”；这一轮“连不上”算通了一轮（K15 复审低 5）
  if (reason === 'bad_data') {
    return {
      active: [{ key: SCOPE_BAD_DATA, title: '服务器数据异常', lines: ['usage-report 回 500 bad_data：private.heartbeat 或 pending_deletions 里有解析不了的时间戳。', '这一轮心跳、注销检查都没做成，请到控制台查这两张表。'] }],
      scopes: [SCOPE_BAD_DATA, SCOPE_UNREACHABLE],
    };
  }
  const title = UNREACHABLE_TITLE;
  const why: Record<string, string> = {
    db_unreachable: '原因：服务器连不上数据库（usage-report 回 503 db_unreachable：查数据库出错或超过 5 秒）。',
    timeout: '原因：调 usage-report 超时（Supabase 暂停、网络问题或函数卡住）。',
    network: '原因：调 usage-report 网络出错（连不上 Supabase）。',
    bad_body: '原因：usage-report 回了 200，但返回体解析不了。',
  };
  const line = why[reason] ?? `原因：usage-report 回 ${reason.slice(5)}。`;
  return { active: [{ key: SCOPE_UNREACHABLE, title, lines: [line] }], scopes: [SCOPE_UNREACHABLE] };
}

// ---------- 每天的用量（架构 6.1 第二条；usage-report 的 usage 部分 B7 才有） ----------

export interface UsageItem {
  key: string;
  label: string;
  pct: number;
}

/** 各项的提醒线和紧急线（百分比）；没列的按 70% 提醒、没有紧急线 */
export const USAGE_LINES: Readonly<Record<string, { warn: number; crit?: number; critText?: string }>> = {
  supabase_storage: { warn: 70, crit: 90 },
  r2_storage: { warn: 80, crit: 100, critText: '已开始收费' },
  r2_ops_write: { warn: 70 },
  r2_ops_read: { warn: 70 },
};

export function parseUsageItems(v: unknown): UsageItem[] | null {
  if (!isObj(v) || v['ok'] !== true || !Array.isArray(v['items'])) return null;
  const out: UsageItem[] = [];
  for (const it of v['items']) {
    if (!isObj(it) || typeof it['key'] !== 'string' || typeof it['label'] !== 'string' || !isNum(it['pct'])) return null;
    out.push({ key: it['key'], label: it['label'], pct: it['pct'] });
  }
  return out;
}

export function evaluateUsage(items: readonly UsageItem[]): Evaluation {
  const active: Issue[] = [];
  for (const it of items) {
    const line = USAGE_LINES[it.key] ?? { warn: 70 };
    if (line.crit !== undefined && it.pct >= line.crit) {
      // 标题不带百分比（审查低）：百分比每天变，带进标题会被当成“情况有变”天天发
      active.push({ key: `usage:${it.key}`, title: `${it.label}到紧急线${line.critText ? `（${line.critText}）` : ''}`, lines: [`现在 ${it.pct}%，紧急线 ${line.crit}%。处理办法见架构 3.4。`] });
    } else if (it.pct >= line.warn) {
      active.push({ key: `usage:${it.key}`, title: `${it.label}超过提醒线`, lines: [`现在 ${it.pct}%，提醒线 ${line.warn}%。处理办法见架构 3.4。`] });
    }
  }
  return { active, scopes: ['usage:', 'usage-call'] };
}
