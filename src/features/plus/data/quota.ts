// AI 次数用完的提示（B3 任务单 FA-2；架构“每天 50 次 AI 额度”，R-187，0.29 续第 128 条）
// • 服务器按太平洋时间的日期计数；恢复时刻 = 下一个太平洋午夜，换成 current_tz 的墙上时间显示（夏令时自动从 17:00 变 16:00）
// • 用完的提示每天只出一次：本机记下“出过提示的那个太平洋日期”（只是个日期，不是用户内容，放 localStorage；换账号最多少提示一次）
// • 剩余次数按账号记在本机库（见文件末尾）
// • 计数日、恢复时刻（QUOTA_TZ、quotaDay、quotaResetAt、quotaResetClock）和服务器同一份：shared/logic/ai-quota.ts（11-07 主持人定），调用方直接引 shared 那一份
//   （hooks/useTypeBar.ts、设置 › 语音与 AI）；这里只留用 localStorage 的“每天提示一次”和按账号记的剩余次数
// 纯 TS：不准 import React（A1）
import { quotaDay } from '../../../../shared/logic/ai-quota.ts';
import { getBoot } from '../../../core/boot.ts';
import type { Cache } from '../../../core/cache.ts';

export const QUOTA_NOTICE_KEY = 'lemo.plus.quotaNoticeDay';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

const storeOf = (s?: Store): Store | null => {
  try {
    return s ?? localStorage;
  } catch {
    return null;
  }
};

/** 今天还没出过“用完了”的提示 */
export function quotaNoticeDue(now: number, s?: Store): boolean {
  try {
    return storeOf(s)?.getItem(QUOTA_NOTICE_KEY) !== quotaDay(now);
  } catch {
    return true;
  }
}

/** 记下今天出过了（写不进去就算了，最多多提示一次） */
export function markQuotaNotice(now: number, s?: Store): void {
  try {
    storeOf(s)?.setItem(QUOTA_NOTICE_KEY, quotaDay(now));
  } catch {
    // 私密模式、存储被禁：忽略
  }
}

// ---------- 本机记着的剩余次数（架构 5.11：quota_out 后把本机的 quota_left 记成 0，下次直接走本机规则 / 手机自带识别） ----------
// 按账号分（主持人 11-07 定）：和打字条草稿一样放本机库 drafts 仓（id 'capture:quota'），退出、换账号随整库清掉；不放 localStorage。
// 读写失败（库没开、正在关）当“没用完”，最多多调一次 AI，由服务器回 quota_out
export const QUOTA_DRAFT_ID = 'capture:quota';

type DraftStore = Pick<Cache, 'getDraft' | 'putDraft'>;
const cacheOf = (c?: DraftStore | null): DraftStore | null => (c === undefined ? (getBoot()?.cache ?? null) : c);

/** 记下 AI 返回的剩余次数（连同太平洋日期；换了一天自动作废） */
export async function rememberQuotaLeft(left: number, now: number, c?: DraftStore | null): Promise<void> {
  const cache = cacheOf(c);
  if (!cache) return;
  try {
    await cache.putDraft({ id: QUOTA_DRAFT_ID, kind: 'quota', data: { day: quotaDay(now), left: Math.max(0, Math.floor(left)) }, updated_at: now });
  } catch {
    // 库没开、正在关：这次不记
  }
}

/** 今天本机记着已经用完（不是今天记的不算） */
export async function quotaOutToday(now: number, c?: DraftStore | null): Promise<boolean> {
  const cache = cacheOf(c);
  if (!cache) return false;
  try {
    const d = await cache.getDraft(QUOTA_DRAFT_ID);
    const v = d?.data;
    if (typeof v !== 'object' || v === null) return false;
    const x = v as Record<string, unknown>;
    return x['day'] === quotaDay(now) && x['left'] === 0;
  } catch {
    return false;
  }
}
