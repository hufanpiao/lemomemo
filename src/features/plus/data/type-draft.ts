// 打字条的草稿（B3 任务单 S2：下滑收起，已打的字留作草稿；架构 5.1“存在 prefs 里”）
// • 草稿是用户写的内容，按账号分：放本机库的 drafts 仓（core/cache.ts 的 Draft，kind 'capture'），退出、换账号随整库清掉；
//   不放 localStorage（不分账号）
// • 只留一份：id 固定 'capture:type'；空串就删掉
// • 读写失败（库没开、正在关）一律当没有草稿，不抛错
// • B4b-3（架构 5.14 第 2 点）：判成查找、总结、取消改期完成的那一刻原话也写进这一份（assist: true）：iPhone 主屏幕版切后台被杀掉，
//   再点开“＋”照常填回输入条；这种草稿满 ASSIST_DRAFT_MS（24 小时）就不再填回、删掉。“改成记下”存好、关掉结果层时清掉
// 纯 TS：不准 import React（A1）
import type { DateStr } from '../../../../shared/core/date.ts';
import type { Cache, Draft } from '../../../core/cache.ts';
import { getBoot } from '../../../core/boot.ts';

export const TYPE_DRAFT_ID = 'capture:type';
export const TYPE_DRAFT_MAX = 2000;
export const ASSIST_DRAFT_MS = 24 * 60 * 60 * 1000;

export interface TypeDraft {
  text: string;
  /** 日历页打开时选中的那天（R-353）；别的页为 null */
  day: DateStr | null;
  /** 结果层那一刻写的（见文件头）；打字条自己收起时写的没有 */
  assist?: true;
}

type DraftStore = Pick<Cache, 'getDraft' | 'putDraft' | 'deleteDraft'>;

const cacheOf = (c?: DraftStore | null): DraftStore | null => (c === undefined ? (getBoot()?.cache ?? null) : c);

const isDraft = (v: unknown): v is TypeDraft => {
  if (typeof v !== 'object' || v === null) return false;
  const x = v as Record<string, unknown>;
  return typeof x['text'] === 'string' && (x['day'] === null || typeof x['day'] === 'string');
};

export async function readTypeDraft(c?: DraftStore | null, now: number = Date.now()): Promise<TypeDraft | null> {
  const cache = cacheOf(c);
  if (!cache) return null;
  try {
    const d = await cache.getDraft(TYPE_DRAFT_ID);
    if (d && isDraft(d.data) && d.data.assist === true && now - d.updated_at >= ASSIST_DRAFT_MS) {
      await cache.deleteDraft(TYPE_DRAFT_ID);
      return null;
    }
    return d && isDraft(d.data) && d.data.text !== '' ? { text: d.data.text, day: d.data.day } : null;
  } catch {
    return null;
  }
}

export async function writeTypeDraft(draft: TypeDraft, now: number, c?: DraftStore | null): Promise<void> {
  const cache = cacheOf(c);
  if (!cache) return;
  try {
    if (draft.text.trim() === '') {
      await cache.deleteDraft(TYPE_DRAFT_ID);
      return;
    }
    const d: Draft = { id: TYPE_DRAFT_ID, kind: 'capture', data: { text: [...draft.text].slice(0, TYPE_DRAFT_MAX).join(''), day: draft.day, ...(draft.assist ? { assist: true } : {}) }, updated_at: now };
    await cache.putDraft(d);
  } catch {
    // 库没开、正在关：这次不留草稿
  }
}

export async function clearTypeDraft(c?: DraftStore | null): Promise<void> {
  const cache = cacheOf(c);
  if (!cache) return;
  try {
    await cache.deleteDraft(TYPE_DRAFT_ID);
  } catch {
    // 同上
  }
}
