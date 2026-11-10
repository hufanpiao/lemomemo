// ai-classify 写库那部分（代码审查 11-10 必改 3：从 core.ts 拆出来）：本机规则写回、AI 结果写回、新建分类。
// 写的时候都带条件（还是 pending；manual 的只改 ai_status），用户刚好改了就不覆盖（store.ts 的 writeNote）。
import { PROMPT_VERSION } from '../_shared/ai/params.ts';
import type { ClassifyStore, Deps } from './core.ts';
import type { PendingNote } from './request.ts';

/** 架构 5.2：超过 30 个分类后不准再新建 */
export const MAX_CATEGORIES = 30;
/** 每批（一个人一次请求）最多新建几个分类，超出的那几条改用本机规则（安全审 11-10 建议 2） */
export const MAX_NEW_PER_BATCH = 3;
/**
 * 出错（error）的批次一共试几次，**含第一次**（主持人 11-10 定的口径）：第 1、2 次失败记 retry = error 重排，
 * 第 3 次失败 retry 记 null，停在 rule、不再排队。额度用完（quota）不计次数。
 */
export const MAX_TRIES = 3;

export interface Category {
  id: string;
  name: string;
  sort: number;
  deleted_at: number | null;
  merged_into: string | null;
}

/** 写回一条随手记。where：写的时候要满足的条件（还是 pending；manual 的只改 ai_status） */
export interface NotePatch {
  ai_status: 'done' | 'rule';
  ai_meta: Record<string, unknown>;
  category_id?: string;
  category_source?: 'ai' | 'rule';
  category_seen?: boolean;
}

export const live = (c: Category) => c.deleted_at === null && c.merged_into === null;

export type Tally = { ai: number; rule: number; manual: number; skipped: number; failed: number };

const retryOf = (meta: unknown): number => {
  const t = (meta as { tries?: unknown } | null)?.tries;
  return typeof t === 'number' && Number.isInteger(t) && t > 0 ? t : 0;
};

/** 手动分类的：分类永远不改，送 AI 之前就记 done（安全审 11-10 建议 1） */
export async function writeManual(deps: Deps, store: ClassifyStore, userId: string, notes: readonly PendingNote[], tally: Tally): Promise<void> {
  for (const n of notes) {
    await writeOne(deps, store, userId, n.id, { ai_status: 'done', ai_meta: { prompt: PROMPT_VERSION.classify, skip: 'manual' } }, true, tally, 'manual');
  }
}

/** 本机规则写回：retry 不为空时记下重试原因和第几次（出错满 MAX_TRIES 次就不再重排） */
export async function writeRules(
  deps: Deps, store: ClassifyStore, userId: string, notes: readonly PendingNote[], cats: readonly Category[],
  retry: 'quota' | 'error' | null, tally: Tally,
): Promise<void> {
  for (const n of notes) {
    const manual = n.category_source === 'manual';
    // 只有出错（error）计次数；额度用完（quota）不计，额度恢复后照样重排（代码审查 11-10 可选那条）
    const tries = retryOf(n.ai_meta) + (retry === 'error' ? 1 : 0);
    const meta: Record<string, unknown> = retry
      ? { prompt: PROMPT_VERSION.classify, tries, retry: retry === 'quota' ? 'quota' : tries < MAX_TRIES ? 'error' : null }
      : { prompt: PROMPT_VERSION.classify, skip: 'consent' };
    const patch: NotePatch = { ai_status: 'rule', ai_meta: meta };
    if (!manual) {
      const r = deps.logic.classifyByRules(n, cats);
      if (r.category_id !== null) {
        patch.category_id = r.category_id;
        patch.category_source = 'rule';
      }
    }
    await writeOne(deps, store, userId, n.id, patch, manual, tally, 'rule');
  }
}

export async function writeAi(
  deps: Deps, store: ClassifyStore, userId: string, notes: readonly PendingNote[], cats: Category[],
  items: Map<number, { name: string; isNew: boolean }>, canCreate: boolean, model: string, tally: Tally,
): Promise<void> {
  const byName = new Map(cats.map((c) => [deps.logic.normalize(c.name), c] as const));
  let liveCount = cats.length;
  let nextSort = cats.reduce((m, c) => Math.max(m, c.sort), -1) + 1;
  let created = 0;
  const meta = { prompt: PROMPT_VERSION.classify, model };
  for (const [i, n] of notes.entries()) {
    const it = items.get(i);
    let catId: string | null = null;
    if (it) {
      const key = deps.logic.normalize(it.name);
      const hit = key === '' ? undefined : byName.get(key);
      if (hit) catId = hit.id;
      else if (canCreate && liveCount < MAX_CATEGORIES && created < MAX_NEW_PER_BATCH && key !== '') {
        const c = { id: deps.newId(), name: it.name, sort: nextSort };
        try {
          await store.createCategory(userId, c);
          const full: Category = { ...c, deleted_at: null, merged_into: null };
          byName.set(key, full);
          cats.push(full);
          liveCount++;
          created++;
          nextSort++;
          catId = c.id;
        } catch {
          deps.log('category_create_failed');
        }
      }
    }
    if (catId !== null) {
      await writeOne(deps, store, userId, n.id, { ai_status: 'done', ai_meta: meta, category_id: catId, category_source: 'ai', category_seen: false }, false, tally, 'ai');
    } else {
      // AI 没给、给的分类名不合格、不能新建或这一批已经新建了 MAX_NEW_PER_BATCH 个：这一条改用本机规则
      const r = deps.logic.classifyByRules(n, cats);
      const patch: NotePatch = { ai_status: 'rule', ai_meta: { ...meta, skip: 'no_item' } };
      if (r.category_id !== null) {
        patch.category_id = r.category_id;
        patch.category_source = 'rule';
      }
      await writeOne(deps, store, userId, n.id, patch, false, tally, 'rule');
    }
  }
}

export async function writeOne(
  deps: Deps, store: ClassifyStore, userId: string, noteId: string, patch: NotePatch, manual: boolean, tally: Tally, kind: 'ai' | 'rule' | 'manual',
): Promise<void> {
  try {
    await store.writeNote(userId, noteId, patch, manual);
    if (kind === 'ai') tally.ai++;
    else if (kind === 'manual') tally.manual++;
    else tally.rule++;
  } catch {
    deps.log('note_write_failed');
    tally.failed++;
  }
}
