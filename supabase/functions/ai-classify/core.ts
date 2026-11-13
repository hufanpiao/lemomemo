// ai-classify 的处理逻辑（架构 5.2 随手记保存 → AI 分类、第 6 节函数表 ai-classify 行；B4 任务单 S6、硬约束 3、4；TC-B4-05、06）。
// 数据库、AI 服务商、同意检查、本机规则都由 index.ts 注入，Vitest 直接测这一份。不 import npm 包、不 import _shared/gen/、不碰 Deno 全局。
//
// 一轮（pg_cron 每 2 分钟调一次，迁移 20261110120000）：
//   1. 只收 POST；先鉴权（x-cron-secret 定长比较），再判“没配好”（密钥不足 32 字节、没有库客户端回 500 misconfigured）；
//   2. 谷歌额度没用完时，先把上一轮因额度用完、出错记成 rule 的条目重新排队（ai_meta.retry；每条最多试 MAX_TRIES 次）；
//   3. 按人取 pending（private.ai_classify_pending：不是隐私记、没删；每人最多 BATCH_PER_USER 条、最多 SCAN_USERS 个人，
//      按每人最早一条排人，一个人堆得再多也只占一个位置；代码审查 11-10 必改 1）；一轮最多送 MAX_USERS 次 AI；
//      隐私记（is_private）这一批不取：要先解密（R-57），B5 才有，在那之前一直留在 pending；
//   4. 按人逐个处理（一轮墙钟预算 ROUND_BUDGET_MS，到了就不再开始下一个人，剩下的下一轮再做）：
//      ① isUsable：停用、冷静期的账号跳过（0.29 续第 138 条），查不出也跳过；
//      ② aiAllowed（同意、ai.enabled、同意版本）：读不出跳过这个人这一轮；不允许 → 这批只用本机规则，写 ai_status = rule，一条都不送（TC-B4-05）；
//      ③ 谷歌额度用完（ai_state.exhausted_until 没过）、AI 没配好：不动，留在 pending，等能调了再分；
//      ④ 预扣额度：每人每天、全项目每天各 1 次（一批算一次，和 ai-parse 同一组计数）；个人用完 → 留在 pending 等明天；
//         全项目用完 → 退回个人那一次，这一轮后面的人都不再送 AI（TC-B4-06 不超额度）；
//      ⑤ 送 AI：手动分类（category_source = manual）的先挑出来直接记 done，不送；其余一次请求分完；让 AI 从这个人的已有分类里选，确实不合适才提新分类（最多 12 个字；已经有 30 个分类就不准新建，每批最多新建 MAX_NEW_PER_BATCH 个）；
//      ⑥ 写回：category_id、category_source = ai、ai_status = done、category_seen = false（界面上显示“AI”小标）；
//         category_source = manual 的永远不改分类（送 AI 之前就记成 done）；写的时候带条件（还是 pending、不是 manual），用户刚好改了就不覆盖；
//         AI 没给这一条、给的分类名不合格、新建分类失败：这一条改用本机规则，记 rule；
//      ⑥′ 相似分类（R-413）：AI 同时给出这个人已有分类里意思差不多的几对（similar），加进 settings notes.merge_suggest（write.ts 的 writeSimilar），
//         客户端据此提示“合成一个吗？”；读写失败只记日志，不影响分类；
//      ⑦ AI 失败：退回预扣的两次；额度用完写 exhausted_until（太平洋时间下一个午夜）、这一轮后面的人都不再送；
//         这批记成 rule，并在 ai_meta 里记 retry 和第几次，等额度恢复（或下一轮）重新排队；
//         出错一共试 MAX_TRIES 次（含第一次），额度用完不计次数（write.ts）。
// 文件：request.ts 组请求、读回；write.ts 写库；这里只留一轮的流程。
//   5. 写心跳 ai-classify（lemo-ops 15 分钟没更新告警，6.1），detail 只放个数和布尔。
// 合并相近分类的提示（S7）：客户端用 shared/logic/notes/category-merge.ts 的 openPairs 出提示；11-13 起（R-413）本函数只负责把 AI 判的几对
//   写进 settings notes.merge_suggest（不写通知表，B4 任务单待定项 7 照旧），本机三条规则仍由客户端判。
// 日志只记原因码（A23）：不记标题、正文、分类名、密钥、模型原文。

import { cronGate, json } from '../_shared/http.ts';
import { nextPacificMidnight, globalQuotaKey, userQuotaKey, type QuotaStore } from '../_shared/ai/gate.ts';
import type { AIProvider } from '../_shared/ai/provider.ts';
import type { AiConfig } from '../_shared/ai/router.ts';
import { classifyRequest, readItems, readSimilar, type PendingNote } from './request.ts';
import { MAX_CATEGORIES, writeAi, writeManual, writeRules, writeSimilar, type Category, type NotePatch, type Tally } from './write.ts';

export const HEARTBEAT = 'ai-classify';
/** 架构 5.2：每批最多 20 条，一次请求分完 */
export const BATCH_PER_USER = 20;
/** 一轮最多送几次 AI（每人一次请求，最长 CLASSIFY_TIMEOUT_MS） */
export const MAX_USERS = 10;
/**
 * 一轮最多取几个人的 pending（按人取，每人最多 BATCH_PER_USER 条；代码审查 11-10 必改 1）。比 MAX_USERS 多：
 * 额度用完、停用、没同意的人不占送 AI 的名额，后面的人照样轮得到
 */
export const SCAN_USERS = 50;
/** 一轮墙钟预算：过了就不再开始下一个人（pg_net 超时 55 秒，迁移里写） */
export const ROUND_BUDGET_MS = 40_000;

export interface ClassifyStore {
  /** ai_status = rule 且 ai_meta.retry 不为空的，改回 pending；返回改了几条 */
  requeue(): Promise<number>;
  /**
   * 按人取 pending（private.ai_classify_pending）：ai_status = pending、不是隐私记、没删；按每人最早一条的 created_at 排人，
   * 最多 users 个人、每人最多 perUser 条（按 created_at 先后）。同一个人的条目挨在一起
   */
  pending(perUser: number, users: number): Promise<PendingNote[]>;
  /** 这个人的全部分类（含删掉、合并掉的，调用方自己挑） */
  categories(userId: string): Promise<Category[]>;
  /** 新建一个 AI 提议的分类（created_by = ai） */
  createCategory(userId: string, c: { id: string; name: string; sort: number }): Promise<void>;
  /** 带条件写回：manual = true 时只在 category_source = manual 时写，否则只在 category_source <> manual 时写；都要求还是 pending */
  writeNote(userId: string, noteId: string, patch: NotePatch, manual: boolean): Promise<void>;
  /** settings notes.merge_suggest 这一行（R-413）：没有回 null */
  mergeSuggest(userId: string): Promise<{ id: string; value: unknown } | null>;
  /** 写 notes.merge_suggest：id 是已有那一行就改 value，否则用 id 新建一行 */
  writeMergeSuggest(userId: string, id: string, value: unknown, insert: boolean): Promise<void>;
  writeHeartbeat(detail: HeartbeatDetail): Promise<void>;
}

/** 心跳 detail（usage-report 的 DETAIL_FIELDS_BY_NAME['ai-classify'] 白名单转发，只是个数和布尔） */
export type HeartbeatDetail = {
  users: number; notes: number; ai: number; rule: number; manual: number; requeued: number; skipped: number; failed: number; ms: number;
  budget_hit: boolean; quota_hit: boolean;
};

export interface RuleLogic {
  /** shared/logic/notes/classify-rules.ts 的 classifyByRules */
  classifyByRules(note: { title?: string | null; body?: string | null; tags?: readonly string[] | null }, cats: readonly Category[]): { category_id: string | null };
  /** shared/logic/search.ts 的 normalizeForSearch（比分类名用） */
  normalize(s: string): string;
  /** shared/logic/live-row.ts 的 isLiveCategory（删了的、撤销的、合并掉的分类不用） */
  isLiveCategory(c: Category): boolean;
  /** shared/logic/notes/category-merge.ts 的 addSuggested（R-413）：存的值加上这次的几对、去掉不在 live 里的；没变回 null */
  addSuggested(cur: unknown, add: readonly (readonly [string, string])[], live: ReadonlySet<string>): unknown[] | null;
}

export interface Deps {
  cronSecret: string | undefined;
  store: ClassifyStore | null;
  /** private.account_usable（_shared/auth.ts 的 isUsable）；出错抛异常 */
  isUsable(userId: string): Promise<boolean>;
  /** _shared/consent.ts 的 aiAllowed；读不出抛异常 */
  consent(userId: string): Promise<boolean>;
  config(): Promise<AiConfig>;
  provider(cfg: AiConfig): AIProvider | null;
  quota: QuotaStore;
  exhaustedUntil(): Promise<number | null>;
  markExhausted(untilMs: number): Promise<void>;
  logic: RuleLogic;
  newId(): string;
  now(): number;
  log(code: string): void;
}


export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const denied = cronGate(req.headers.get('x-cron-secret'), deps.cronSecret, deps.log);
  if (denied) return denied;
  if (!deps.store) {
    deps.log('misconfigured:store');
    return json(500, { error: 'misconfigured' });
  }
  const detail = await runRound(deps, deps.store);
  try {
    await deps.store.writeHeartbeat(detail);
  } catch {
    deps.log('heartbeat_failed');
    return json(503, { error: 'try_later' });
  }
  return json(200, { ok: true, ...detail });
}

export async function runRound(deps: Deps, store: ClassifyStore): Promise<HeartbeatDetail> {
  const t0 = deps.now();
  const tally: Tally = { ai: 0, rule: 0, manual: 0, skipped: 0, failed: 0 };
  let requeued = 0;
  let budgetHit = false;

  // 谷歌额度：读不出按“用完”算（不送 AI，留在 pending），免得库一抖就把一批记成 rule
  let exhausted: boolean;
  try {
    const until = await deps.exhaustedUntil();
    exhausted = until !== null && until > t0;
  } catch {
    deps.log('ai_state_read_failed');
    exhausted = true;
  }
  const quotaHitAtStart = exhausted;

  if (!exhausted) {
    try {
      requeued = await store.requeue();
    } catch {
      deps.log('requeue_failed');
    }
  }

  let pending: PendingNote[];
  try {
    pending = await store.pending(BATCH_PER_USER, SCAN_USERS);
  } catch {
    deps.log('pending_read_failed');
    return { users: 0, notes: 0, ...tally, requeued, ms: deps.now() - t0, budget_hit: false, quota_hit: quotaHitAtStart, failed: 1 };
  }
  const byUser = new Map<string, PendingNote[]>();
  for (const n of pending) {
    const list = byUser.get(n.user_id) ?? [];
    if (list.length < BATCH_PER_USER) list.push(n);
    byUser.set(n.user_id, list);
  }
  const users = [...byUser.entries()].slice(0, SCAN_USERS);

  // AI 配好没有：读不出或没配，这一轮只处理“不同意”的人（记 rule），能送 AI 的留在 pending
  let provider: AIProvider | null = null;
  let cfg: AiConfig | null = null;
  try {
    cfg = await deps.config();
    provider = deps.provider(cfg);
    if (!provider) deps.log('ai_not_configured');
  } catch {
    deps.log('config_read_failed');
  }
  let globalOut = false;
  let quotaHit = quotaHitAtStart;
  let notesSeen = 0;

  let aiCalls = 0;
  let usersSeen = 0;
  for (const [userId, notes] of users) {
    if (deps.now() - t0 >= ROUND_BUDGET_MS) {
      budgetHit = true;
      break;
    }
    usersSeen++;
    notesSeen += notes.length;
    let usable: boolean;
    try {
      usable = await deps.isUsable(userId);
    } catch {
      deps.log('usable_read_failed');
      tally.skipped += notes.length;
      continue;
    }
    if (!usable) {
      tally.skipped += notes.length;
      continue;
    }
    let allowed: boolean;
    try {
      allowed = await deps.consent(userId);
    } catch {
      deps.log('consent_read_failed');
      tally.skipped += notes.length;
      continue;
    }
    let cats: Category[];
    try {
      cats = (await store.categories(userId)).filter(deps.logic.isLiveCategory);
    } catch {
      deps.log('categories_read_failed');
      tally.skipped += notes.length;
      continue;
    }
    if (!allowed) {
      await writeRules(deps, store, userId, notes, cats, null, tally);
      continue;
    }
    // 手动分类的不送 AI（安全审 11-10 建议 1）：分类永远不改，直接记 done，正文不出本机
    await writeManual(deps, store, userId, notes.filter((n) => n.category_source === 'manual'), tally);
    const toAi = notes.filter((n) => n.category_source !== 'manual');
    if (toAi.length === 0) continue;
    if (exhausted || globalOut || !provider || !cfg || aiCalls >= MAX_USERS) {
      tally.skipped += toAi.length;
      continue;
    }
    const now = deps.now();
    const userKey = userQuotaKey(userId, now);
    const globalKey = globalQuotaKey(now);
    let userTaken = false;
    try {
      const used = await deps.quota.take(userKey, cfg.per_user_daily);
      if (used === null) {
        tally.skipped += toAi.length;
        continue;
      }
      userTaken = true;
      const g = await deps.quota.take(globalKey, cfg.global_daily ?? 0);
      if (g === null) {
        userTaken = false;   // 下面这次退回出错时，catch 里不再退第二次
        await deps.quota.refund(userKey);
        deps.log('global_quota_out');
        globalOut = true;
        tally.skipped += toAi.length;
        continue;
      }
    } catch {
      deps.log('quota_failed');
      // 个人那一下扣上了、全项目那一下出错：退回个人的；全项目那一下扣没扣上不知道，不退（宁可多算）
      if (userTaken) await deps.quota.refund(userKey).catch(() => deps.log('settle_failed'));
      tally.skipped += toAi.length;
      continue;
    }

    const canCreate = cats.length < MAX_CATEGORIES;
    const catNames = cats.map((c) => c.name);
    aiCalls++;
    let res;
    try {
      res = await provider.generate(classifyRequest(toAi, catNames, canCreate));
    } catch {
      res = { ok: false as const, reason: 'error' as const };
    }
    const items = res.ok ? readItems(res.json, toAi.length) : new Map<number, { name: string; isNew: boolean }>();
    if (!res.ok || items.size === 0) {
      const reason = res.ok ? 'invalid' : res.reason;
      deps.log(`ai_${reason}`);
      const settle = await Promise.allSettled([
        deps.quota.refund(userKey), deps.quota.refund(globalKey),
        ...(reason === 'quota' ? [deps.markExhausted(nextPacificMidnight(deps.now()))] : []),
      ]);
      if (settle.some((x) => x.status === 'rejected')) deps.log('settle_failed');
      if (reason === 'quota') {
        exhausted = true;
        quotaHit = true;
      }
      await writeRules(deps, store, userId, toAi, cats, reason === 'quota' ? 'quota' : 'error', tally);
      continue;
    }
    await writeAi(deps, store, userId, toAi, cats, items, canCreate, provider.model, tally);
    await writeSimilar(deps, store, userId, cats, readSimilar(res.json, catNames, deps.logic.normalize));
  }

  return {
    users: usersSeen, notes: notesSeen, ...tally, requeued, ms: deps.now() - t0, budget_hit: budgetHit, quota_hit: quotaHit,
  };
}
