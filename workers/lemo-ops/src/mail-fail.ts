// 发信失败另记（R-261，架构 15.6 第 4d 条 ①“lemo-ops 发信失败时另记心跳”）：KV 键 mail-fail:v1，两个 cron 共用。
// 只记时刻、封数和 Resend 回的 HTTP 码，不记收件人、邮箱、标题、正文；读写由 alerts.ts 的 runAlerts 单独 try，出错不影响告警本身。
// 负责人去 Cloudflare 控制台 → Workers KV → lemo-ops-state → mail-fail:v1 看（上线与回滚手册第八节）。

import { stamp } from './stamp.ts';

export const MAIL_FAIL_KEY = 'mail-fail:v1';

/**
 * 发信失败记录。时刻一律 ISO 字符串（UTC），方便在控制台直接看。
 * - count：上次发成功以后没发出去的告警封数。口径（主持人 10-30 确认）：**按每次发失败算一封**——同一件事下一轮重试又失败再算一封，
 *   连续 3 轮失败就是 3，哪怕这件事后来补发成功了；
 * - first_at：这一串失败里第一封的时刻，count 清零时置 null；
 * - last_at、last_status：最近一次失败的时刻和 Resend 回的 HTTP 码，清零后留着当历史。口径（主持人 10-30 确认）：
 *   **超时或网络出错没有回应时 last_status 记 null**（没有 HTTP 码可记）；
 * - last_ok_at：最近一次发成功的时刻。
 */
export interface MailFail {
  first_at: string | null;
  last_at: string | null;
  count: number;
  last_status: number | null;
  last_ok_at: string | null;
}

export function emptyMailFail(): MailFail {
  return { first_at: null, last_at: null, count: 0, last_status: null, last_ok_at: null };
}

const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

/** 读 mail-fail:v1；坏了或没有就当从零开始（最坏少提示一次，不影响告警） */
export function parseMailFail(raw: string | null): MailFail {
  let v: unknown = null;
  try {
    v = raw === null ? null : JSON.parse(raw);
  } catch {
    v = null;
  }
  if (typeof v !== 'object' || v === null) return emptyMailFail();
  const o = v as Record<string, unknown>;
  const count = o['count'];
  const st = o['last_status'];
  const n = typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : 0;
  return {
    // count 为 0 时 first_at 一定是 null：坏数据留下的旧时刻不能让下一串失败沿用
    first_at: n === 0 ? null : isoOrNull(o['first_at']),
    last_at: isoOrNull(o['last_at']),
    count: n,
    last_status: typeof st === 'number' && Number.isInteger(st) ? st : null,
    last_ok_at: isoOrNull(o['last_ok_at']),
  };
}

/** 记一次发信结果：成功写 last_ok_at、count 清零、first_at 置空；失败 count 加 1，记时刻和 HTTP 码 */
export function recordSend(f: MailFail, ok: boolean, status: number | null, now: number): MailFail {
  const at = new Date(now).toISOString();
  if (ok) return { ...f, first_at: null, count: 0, last_ok_at: at };
  return { ...f, first_at: f.first_at ?? at, last_at: at, count: f.count + 1, last_status: status };
}

/**
 * 发成功的那封信末尾加的提示：中文一句、韩文一句。只写封数、第一封失败的时刻和最近一次的 HTTP 码，
 * 指到 KV 的 mail-fail:v1 去看；不写收件人。
 */
export function missedNotice(f: MailFail): string {
  const first = f.first_at === null ? null : Date.parse(f.first_at);
  const zhWhen = first === null ? '' : `，第一次失败是 ${stamp(first)}`;
  const koWhen = first === null ? '' : `, 처음 실패: ${stamp(first, true)}`;
  const zhStatus = f.last_status === null ? '没有回应（超时或网络出错）' : `HTTP ${f.last_status}`;
  const koStatus = f.last_status === null ? '응답 없음(시간 초과 또는 네트워크 오류)' : `HTTP ${f.last_status}`;
  // “一般在下一轮重发”而不是“会接着重发”：退回状态那次 KV 写失败时要等 6 小时后的“仍未恢复”，当天额度用完时不发（审查建议 10-30）
  return [
    `此前有 ${f.count} 次告警发信失败${zhWhen}，最近一次 Resend 回：${zhStatus}。没发出的事项一般会在下一轮重发；详情看 Cloudflare KV 的 ${MAIL_FAIL_KEY}。`,
    `이전에 알림 메일 발송이 ${f.count}회 실패했습니다${koWhen}. 마지막 Resend 응답: ${koStatus}. 보내지 못한 항목은 보통 다음 회차에 다시 보냅니다. 자세한 내용은 Cloudflare KV의 ${MAIL_FAIL_KEY} 항목을 확인하세요.`,
  ].join('\n');
}

/** 之前有没发出的（count > 0）就在正文末尾空一行接上提示；没有就原样 */
export const withMissedNotice = (text: string, f: MailFail | null): string =>
  f !== null && f.count > 0 ? `${text}\n\n${missedNotice(f)}` : text;
