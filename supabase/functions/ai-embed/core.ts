// ai-embed：后台算向量（架构 5.13 第 6 点“每条一条”“哪些需要重算：队列”、第 6 节 ai-embed 行、0.27 第 3 点；R-112、R-116；B4b-2）。
// 纯逻辑，依赖由 index.ts 注入，Vitest 直接测（tests/edge/ai-embed.test.ts）。
// 每 2 分钟由 pg_cron 带 x-cron-secret 调一次（迁移 20261115020000_search_embed_cron.sql）：
//   ① 从扫描视图 private.scan_embed_queue 随机挑最多 USERS_MAX 个有到期队列项的人（随机：卡住的人不占着名额，同 file-check 补扫）；
//   ② 逐人（一轮墙钟预算 ROUND_BUDGET_MS，同 ai-classify：到了就不再开始下一个人，免得和下一轮 cron 叠着跑）：isUsable、aiAllowed（不过 → 这个人到期的队列项推后 1 天，不送任何内容；撤回同意时队列已被 record_consent_impl 删光）；
//   ③ 读这个人最早的 ITEMS_PER_USER 个到期队列项和源头内容（fn_ai，app.uid = 本人）：
//      源头没了、删了（deleted_at）、没有可算的字（图片还没有描述）→ 只删队列行；
//      隐私记（notes.is_private、vault-images 的图片、is_vault 的文档）→ 推后 VAULT_LATER_MS（30 天）、留在队列里：服务器解密算向量（VAULT_KEY）
//      这一批不做（见报告）；不每天空扫一遍，做的时候由那一批把这些行的 next_at 清掉；
//   ④ 拼文字（5.13 第 6 点）：随手记 = 标题 + 正文；图片 = 描述 + 标签 + 所在随手记的标题；文档 = 文件名 + 抽出文字（前 FILE_TEXT_MAX 字）+ 描述；
//      日程 = 标题 + 地点 + 备注；待办 = 标题 + 备注（5.14 第 3 点）。分类名不进：fn_ai 没有 categories 的授权（不为它加授权，见报告）；
//      sha256 和已有向量的 content_hash 一样 → 不调模型，只删队列行（0.27：按模型分开比）；
//   ⑤ 剩下的一次 batchEmbedContents（gemini-embedding-2、768 维）；先过全项目每天 embed:global:<太平洋日期>（ai.embed_daily_global，
//      没配按 DEFAULT_DAILY_GLOBAL，代定），一次批量调用算 1 次；用完本轮停；
//   ⑥ 写向量：同一事务里先取 pg_advisory_xact_lock(hashtext('embed:' || user_id))（和撤回同意、vault_ai_off 删向量互斥，0.27），
//      只在队列行还在、queued_at 没变时写，并锁住这一行（for update）：撤回同意、关掉 ai.vault 删了队列行，或处理中移进隐私记、改了内容
//      （入队触发器更新 queued_at）都不写——移进隐私记的事务没提交时等它提交再判，先写完的会被它随后的 dropVectors 删掉；on conflict 覆盖；
//      再删队列行，只删 queued_at 没变的（处理中又改过的留着下一轮重算）；
//   ⑦ 失败：谷歌 429 → 这批推到 exhaustedUntilFor（每分钟的按 retryDelay，每天的到太平洋午夜，同 gate.ts）、本轮停；
//      超时、出错 → tries + 1，按 BACKOFF_MS 退避（10 分钟、1 小时、6 小时）；试满 MAX_TRIES 次的删队列行、计 gave_up（源头再改会重新入队）；
//   ⑧ 写心跳 ai-embed（只有计数）。日志只记码和数，不记内容。
import { errorResponder, json, NO_STORE, cronGate } from '../_shared/http.ts';
import { exhaustedUntilFor, pacificDate } from '../_shared/ai/gate.ts';
import { docText, type EmbedKind, type EmbedResult } from '../_shared/ai/embed.ts';
import { QUOTA_WINDOW_S } from '../_shared/ai/store.ts';
import { isObj } from '../_shared/obj.ts';

export type { EmbedKind };

export const USERS_MAX = 20;
export const ITEMS_PER_USER = 20;
export const EMBED_TIMEOUT_MS = 20_000;
/** 文档抽出文字最多送几个字（5.13 第 6 点“前 2000 字”） */
export const FILE_TEXT_MAX = 2_000;
/** 一条最多送几个字（随手记正文很长时截断；模型单次 8192 token） */
export const TEXT_MAX = 4_000;
/** ai.embed_daily_global 没配时的全项目每天上限（代定：免费层每天的请求数量级，负责人在 app_config 里改） */
export const DEFAULT_DAILY_GLOBAL = 1_000;
export const LATER_MS = 24 * 3600_000;
export const VAULT_LATER_MS = 30 * LATER_MS;
export const BACKOFF_MS = [10 * 60_000, 3600_000, 6 * 3600_000] as const;
/** 出错最多试几次（含第一次）；满了删队列行 */
export const MAX_TRIES = 6;
/** 一轮墙钟预算（同 ai-classify 的 ROUND_BUDGET_MS）：到了不再开始下一个人 */
export const ROUND_BUDGET_MS = 40_000;

export interface QItem {
  kind: EmbedKind;
  source_id: string;
  /** '' = 当前模型 */
  model: string;
  /** 读出来时的 queued_at（原样字符串），删行时比对 */
  queued_at: string;
  tries: number;
}

/** 源头内容：gone 源头没了或删了、empty 没有可算的字、vault 隐私记 */
export type Src = { state: 'gone' | 'empty' | 'vault' } | { state: 'ok'; title: string; text: string };

export interface Store {
  users(limit: number): Promise<string[]>;
  items(userId: string, limit: number): Promise<QItem[]>;
  /** 每一项的源头；key = kind:source_id */
  sources(userId: string, items: readonly QItem[]): Promise<Map<string, Src>>;
  /** 已有向量的 content_hash；key = kind:source_id */
  hashes(userId: string, items: readonly QItem[], model: string): Promise<Map<string, string>>;
  /** 取锁、队列行还在才写；回写成没有 */
  write(userId: string, item: QItem, model: string, hash: string, vec: readonly number[]): Promise<boolean>;
  /** 删队列行（queued_at 没变的） */
  settle(userId: string, items: readonly QItem[]): Promise<void>;
  /** 推后：next_at = at；bump 时 tries + 1 */
  later(userId: string, items: readonly QItem[], at: number, bump: boolean): Promise<void>;
  heartbeat(detail: Record<string, number>): Promise<void>;
}

export interface EmbedConfig {
  embedModel: string | null;
  dailyGlobal: number | null;
}

/** app_config.ai 里的 embed_model、embed_daily_global（格式不对按没配） */
export function readEmbedConfig(ai: unknown): EmbedConfig {
  const o = isObj(ai) ? ai : {};
  const m = o['embed_model'];
  const g = o['embed_daily_global'];
  return {
    embedModel: typeof m === 'string' && m !== '' ? m : null,
    dailyGlobal: typeof g === 'number' && Number.isInteger(g) && g >= 0 ? g : null,
  };
}

export interface Deps {
  cronSecret: string | undefined;
  store: Store | null;
  isUsable(userId: string): Promise<boolean>;
  consent(userId: string): Promise<boolean>;
  config(): Promise<EmbedConfig>;
  takeRate(key: string, limit: number, windowS: number): Promise<boolean>;
  embedder(model: string): ((texts: readonly string[], timeoutMs: number) => Promise<EmbedResult>) | null;
  sha256Hex(text: string): Promise<string>;
  now(): number;
  log(code: string): void;
}

export const keyOf = (i: { kind: string; source_id: string }): string => `${i.kind}:${i.source_id}`;
const cut = (s: string, n: number): string => [...s].slice(0, n).join('');
const lines = (...xs: (string | null | undefined)[]): string => xs.map((x) => (x ?? '').trim()).filter((x) => x !== '').join('\n');

/** 一条送模型的文字（docText 前缀见 _shared/ai/embed.ts） */
export const embedInput = (s: { title: string; text: string }): string => docText(cut(s.title, 200), cut(s.text, TEXT_MAX));

/** 拼正文的几种写法（store.ts 读出源头列以后调；单测直接核对） */
export const srcText = {
  note: (title: string | null, body: string | null) => ({ title: title ?? '', text: body ?? '' }),
  event: (title: string | null, location: string | null, note: string | null) => ({ title: title ?? '', text: lines(location, note) }),
  todo: (title: string | null, note: string | null) => ({ title: title ?? '', text: note ?? '' }),
  image: (desc: string | null, tags: readonly string[] | null, noteTitle: string | null) => ({ title: noteTitle ?? '', text: lines(desc, (tags ?? []).join(' ')) }),
  file: (name: string | null, excerpt: string | null, desc: string | null, tags: readonly string[] | null) => ({
    title: name ?? '', text: lines(cut(excerpt ?? '', FILE_TEXT_MAX), desc, (tags ?? []).join(' ')),
  }),
};

export const backoffAt = (now: number, tries: number): number => now + (tries <= 0 ? BACKOFF_MS[0] : tries === 1 ? BACKOFF_MS[1] : BACKOFF_MS[2]);

type Detail = { users: number; items: number; embedded: number; same: number; dropped: number; vault: number; skipped_users: number; failed: number; gave_up: number; quota: number };

/** 一个人的一轮；回 'stop' 表示谷歌或全项目额度用完、本轮不再往下做 */
async function oneUser(uid: string, deps: Deps, store: Store, cfg: EmbedConfig & { embedModel: string }, d: Detail): Promise<'ok' | 'stop'> {
  const now = deps.now();
  const items = await store.items(uid, ITEMS_PER_USER);
  if (items.length === 0) return 'ok';
  d.users += 1;
  d.items += items.length;
  if (!(await deps.isUsable(uid)) || !(await deps.consent(uid))) {
    d.skipped_users += 1;
    await store.later(uid, items, now + LATER_MS, false);
    return 'ok';
  }
  const src = await store.sources(uid, items);
  const drop: QItem[] = [];
  const same: QItem[] = [];
  const vault: QItem[] = [];
  const todo: { item: QItem; input: string; model: string }[] = [];
  for (const it of items) {
    const s = src.get(keyOf(it)) ?? { state: 'gone' as const };
    if (s.state === 'vault') vault.push(it);
    else if (s.state !== 'ok' || (s.title.trim() === '' && s.text.trim() === '')) drop.push(it);
    else todo.push({ item: it, input: embedInput(s), model: it.model === '' ? cfg.embedModel : it.model });
  }
  if (vault.length > 0) await store.later(uid, vault, now + VAULT_LATER_MS, false);
  d.vault += vault.length;
  // 同一批里模型都一样才合一次调用；补算（model 不是空串）这一批不排，按模型分开逐组算
  const byModel = new Map<string, typeof todo>();
  for (const t of todo) byModel.set(t.model, [...(byModel.get(t.model) ?? []), t]);
  let result: 'ok' | 'stop' = 'ok';
  for (const [model, group] of byModel) {
    const old = await store.hashes(uid, group.map((g) => g.item), model);
    const fresh: (typeof group[number] & { hash: string })[] = [];
    for (const g of group) {
      const hash = await deps.sha256Hex(g.input);
      if (old.get(keyOf(g.item)) === hash) same.push(g.item);
      else fresh.push({ ...g, hash });
    }
    if (fresh.length === 0) continue;
    const embed = deps.embedder(model);
    if (!embed) {
      deps.log('misconfigured:embed');
      return 'stop';
    }
    if (!(await deps.takeRate(`embed:global:${pacificDate(now)}`, cfg.dailyGlobal ?? DEFAULT_DAILY_GLOBAL, QUOTA_WINDOW_S))) {
      deps.log('daily_global_out');
      result = 'stop';
      break;
    }
    const e = await embed(fresh.map((f) => f.input), EMBED_TIMEOUT_MS);
    if (!e.ok) {
      deps.log(`embed_${e.reason}${e.quotaKind ? ` kind=${e.quotaKind}` : ''}${e.status ? ` status=${e.status}` : ''}`);
      if (e.reason === 'quota') {
        d.quota += fresh.length;
        await store.later(uid, fresh.map((f) => f.item), exhaustedUntilFor(now, e), false);
        result = 'stop';
        break;
      }
      const spent = fresh.filter((f) => f.item.tries + 1 >= MAX_TRIES).map((f) => f.item);
      d.failed += fresh.length - spent.length;
      d.gave_up += spent.length;
      await store.settle(uid, spent);
      for (const f of fresh) if (f.item.tries + 1 < MAX_TRIES) await store.later(uid, [f.item], backoffAt(now, f.item.tries), true);
      continue;
    }
    const done: QItem[] = [];
    for (let i = 0; i < fresh.length; i++) {
      const f = fresh[i];
      const vec = e.vectors[i];
      if (!f) continue;
      if (vec && (await store.write(uid, f.item, model, f.hash, vec))) {
        done.push(f.item);
        d.embedded += 1;
      }
    }
    await store.settle(uid, done);
  }
  if (drop.length + same.length > 0) await store.settle(uid, [...drop, ...same]);
  d.dropped += drop.length;
  d.same += same.length;
  return result;
}

type Code = 'method_not_allowed' | 'misconfigured';
const err = errorResponder<Code>();

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return err(405, 'method_not_allowed');
  const denied = cronGate(req.headers.get('x-cron-secret'), deps.cronSecret, deps.log);
  if (denied) return denied;
  const store = deps.store;
  if (!store) {
    deps.log('misconfigured');
    return err(500, 'misconfigured');
  }
  const d: Detail = { users: 0, items: 0, embedded: 0, same: 0, dropped: 0, vault: 0, skipped_users: 0, failed: 0, gave_up: 0, quota: 0 };
  let cfg: EmbedConfig;
  try {
    cfg = await deps.config();
  } catch {
    deps.log('config_failed');
    return json(503, { error: 'try_later' }, NO_STORE);
  }
  const model = cfg.embedModel;
  try {
    if (model) {
      const t0 = deps.now();
      for (const uid of await store.users(USERS_MAX)) {
        if (deps.now() - t0 >= ROUND_BUDGET_MS) {
          deps.log('round_budget');
          break;
        }
        try {
          if ((await oneUser(uid, deps, store, { ...cfg, embedModel: model }, d)) === 'stop') break;
        } catch {
          d.failed += 1;
          deps.log('user_failed');
        }
      }
    } else deps.log('no_embed_model');
    await store.heartbeat(d);
  } catch {
    deps.log('try_later');
    return json(503, { error: 'try_later' }, NO_STORE);
  }
  return json(200, { ok: true, ...d }, NO_STORE);
}
