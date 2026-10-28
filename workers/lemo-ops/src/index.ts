// 独立 Worker lemo-ops（架构 6.1）：Cron Trigger 每 15 分钟查心跳、每天查用量并保活，出问题用 Resend 给产品负责人发邮件。
// 两个 cron 表达式写在 ../wrangler.toml，这里按 controller.cron 分开；表达式改了两处一起改（tests/build/lemo-ops-config.test.ts 核对）。
// 没有 fetch 入口：不对外提供任何网址。

import { runAlerts, type LogFn, type Mail, type StateStore } from './alerts.ts';
import { callUsageReport, keepalive, sendMail, type FetchFn, type OpsConfig } from './http.ts';
import {
  evaluateHeartbeat,
  evaluateUnreachable,
  evaluateUsage,
  parseHeartbeatReport,
  parseUsageItems,
  type Evaluation,
} from './rules.ts';

export const CRON_HEARTBEAT = '*/15 * * * *';
/** 每天 UTC 00:07（首尔 09:07）；错开整点，免得和 15 分钟那一轮同时读写 KV 状态 */
export const CRON_DAILY = '7 0 * * *';

export interface Env {
  OPS_STATE: StateStore;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  OPS_SECRET?: string;
  RESEND_API_KEY_OPS?: string;
  ALERT_TO?: string;
  ALERT_FROM?: string;
  /** 逗号分隔：没有心跳行也要告警的 cron 函数名（已上线的才写进来） */
  REQUIRED_HEARTBEATS?: string;
  /** "on" 时每天查 usage-report {part: usage}（B7 usage 部分做好后再开）；其他值只保活 */
  USAGE_CHECK?: string;
}

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'OPS_SECRET', 'RESEND_API_KEY_OPS', 'ALERT_TO', 'ALERT_FROM'] as const;

/** 读配置；缺了哪项只报名字（不报值）。SUPABASE_URL 必须是 https（本机调试允许 http://127.0.0.1、localhost） */
export function readConfig(env: Env): OpsConfig {
  const missing = REQUIRED_ENV.filter((k) => !env[k]);
  if (missing.length > 0) throw new Error(`lemo-ops 配置缺：${missing.join('、')}`);
  const url = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('lemo-ops 配置错：SUPABASE_URL 不是网址');
  }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('lemo-ops 配置错：SUPABASE_URL 必须是 https');
  if (u.pathname !== '/' && u.pathname !== '') throw new Error('lemo-ops 配置错：SUPABASE_URL 只写到域名（直连 <ref>.supabase.co，不经 /sb）');
  return {
    supabaseUrl: `${u.protocol}//${u.host}`,
    anonKey: env.SUPABASE_ANON_KEY ?? '',
    opsSecret: env.OPS_SECRET ?? '',
    resendKey: env.RESEND_API_KEY_OPS ?? '',
    alertTo: env.ALERT_TO ?? '',
    alertFrom: env.ALERT_FROM ?? '',
  };
}

function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export interface RunResult {
  sent: Mail[];
}

/** 日志只记错误码或变量名，不记任何值（A23） */
export const consoleLog: LogFn = (code) => console.error(`lemo-ops: ${code}`);

function hourOf(ms: number): string {
  const d = new Date(ms).toISOString();
  return `${d.slice(0, 4)}${d.slice(5, 7)}${d.slice(8, 10)}T${d.slice(11, 13)}`;
}

/** 每 15 分钟：心跳、冷静期删除、长事务、清理慢批、推送失败比例、钩子出错，以及“监控连不上服务器” */
export async function runHeartbeat(env: Env, fetchFn: FetchFn, now: number, log: LogFn = consoleLog): Promise<RunResult> {
  const cfg = readConfig(env);
  const send = (m: Mail) => sendMail(fetchFn, cfg, m.subject, m.text);
  const res = await callUsageReport(fetchFn, cfg, 'heartbeat');
  let ev: Evaluation;
  if (!res.ok) {
    ev = evaluateUnreachable(res.reason);
  } else {
    const report = parseHeartbeatReport(res.body);
    if (!report) {
      ev = evaluateUnreachable('bad_body');
    } else {
      ev = evaluateHeartbeat(report, list(env.REQUIRED_HEARTBEATS));
      // 服务器按小时去重（hook-alert:global:<小时>，0.29 续第 115 条）；这里再按小时记进 KV，发失败的下一轮重试
      if (report.alert === true) ev.hookHour = hourOf(now);
    }
  }
  return { sent: await runAlerts(env.OPS_STATE, 'heartbeat', [ev], now, send, log) };
}

/** 每天一次：保活（真查一次数据库）；USAGE_CHECK=on 时另查用量 */
export async function runDaily(env: Env, fetchFn: FetchFn, now: number, log: LogFn = consoleLog): Promise<RunResult> {
  const cfg = readConfig(env);
  const send = (m: Mail) => sendMail(fetchFn, cfg, m.subject, m.text);
  const evs: Evaluation[] = [];
  const ka = await keepalive(fetchFn, cfg);
  evs.push({
    active: ka === null ? [] : [{ key: 'keepalive', title: '每天的保活查询失败', lines: [`GET /rest/v1/app_config 失败：${ka}。连续几天失败，免费版项目可能被暂停。`] }],
    scopes: ['keepalive'],
  });
  if (env.USAGE_CHECK === 'on') {
    const res = await callUsageReport(fetchFn, cfg, 'usage');
    const items = res.ok ? parseUsageItems(res.body) : null;
    // 查成功时 evaluateUsage 的范围含 usage-call，之前的“用量查询失败”才能恢复（审查必改 2）
    if (items) evs.push(evaluateUsage(items));
    else evs.push({ active: [{ key: 'usage-call', title: '每天的用量查询失败', lines: [`usage-report {part: usage}：${res.ok ? 'bad_body' : res.reason}。`] }], scopes: ['usage-call'] });
  } else {
    // 关掉用量检查后，之前留下的用量状态悄悄删掉，不发“已恢复”
    evs.push({ active: [], scopes: [], drop: ['usage:', 'usage-call'] });
  }
  return { sent: await runAlerts(env.OPS_STATE, 'daily', evs, now, send, log) };
}

/** 定时入口：出错只记一行（配置错误只含变量名，其他只记错误类型），不把原始错误抛出去 */
export async function runScheduled(cron: string, env: Env, fetchFn: FetchFn, now: number, log: LogFn = consoleLog): Promise<void> {
  try {
    await (cron === CRON_DAILY ? runDaily : runHeartbeat)(env, fetchFn, now, log);
  } catch (e) {
    log(e instanceof Error && e.message.startsWith('lemo-ops 配置') ? e.message : `运行出错：${e instanceof Error ? e.name : 'unknown'}`);
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(controller.cron, env, (input, init) => fetch(input, init), controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
