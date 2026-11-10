// ai-classify 单测共用替身（tests/edge/ai-classify.test.ts、ai-classify-quota.test.ts）：内存假库（照 store.ts 和 private.ai_classify_pending 的条件）、
// 内存额度、回放桩拼接、setup。服务商是真的 GeminiProvider，fetch 换成回放桩，不联网、不用真密钥。
import { classifyByRules } from '../../shared/logic/notes/classify-rules.ts';
import { normalizeForSearch } from '../../shared/logic/search.ts';
import { GeminiProvider } from '../../supabase/functions/_shared/ai/gemini.ts';
import type { QuotaStore } from '../../supabase/functions/_shared/ai/gate.ts';
import type { AiConfig } from '../../supabase/functions/_shared/ai/router.ts';
import { handle, type ClassifyStore, type Deps, type HeartbeatDetail } from '../../supabase/functions/ai-classify/core.ts';
import type { Category, NotePatch } from '../../supabase/functions/ai-classify/write.ts';
import { loadCassette, type Cassette } from '../ai/replay/cassette.ts';
import { replay, REPLAY_KEY, REPLAY_MODEL, type Replay } from '../ai/replay/replay.ts';

export const SECRET = 's'.repeat(40);
export const NOW = 1793581200000;   // 2026-11-02T10:00:00+09:00
export const A = '00000000-0000-4000-8000-00000000000a';
export const B = '00000000-0000-4000-8000-00000000000b';

export type Note = {
  id: string; user_id: string; title: string | null; body: string | null; tags: string[]; is_private: boolean; deleted_at: number | null;
  ai_status: string; ai_meta: unknown; category_id: string | null; category_source: string; category_seen: boolean;
};
export const note = (id: string, user: string, title: string, o: Partial<Note> = {}): Note => ({
  id, user_id: user, title, body: null, tags: [], is_private: false, deleted_at: null, ai_status: 'pending', ai_meta: null,
  category_id: null, category_source: 'none', category_seen: true, ...o,
});
export const cat = (id: string, user: string, name: string, o: Partial<Category> = {}): Category & { user_id: string } =>
  ({ id, user_id: user, name, sort: 0, deleted_at: null, merged_into: null, ...o });

/** 内存里的库：写回照 store.ts 的条件（还是 pending；manual 只在 manual 时写，否则只在不是 manual 时写） */
export function fakeDb(notes: Note[], cats: (Category & { user_id: string })[]) {
  const heartbeats: HeartbeatDetail[] = [];
  const store: ClassifyStore = {
    async requeue() {
      let n = 0;
      for (const x of notes) {
        const r = (x.ai_meta as { retry?: unknown } | null)?.retry;
        if (x.ai_status === 'rule' && !x.is_private && (r === 'quota' || r === 'error')) { x.ai_status = 'pending'; n++; }
      }
      return n;
    },
    // 照 private.ai_classify_pending：数组顺序当 created_at；按每人最早一条排人，最多 users 个人、每人最多 perUser 条（rls/43 测真函数）
    async pending(perUser, users) {
      const live = notes.filter((x) => x.ai_status === 'pending' && !x.is_private && x.deleted_at === null);
      const who = [...new Set(live.map((x) => x.user_id))].slice(0, users);
      return who.flatMap((u) => live.filter((x) => x.user_id === u).slice(0, perUser))
        .map((x) => ({ id: x.id, user_id: x.user_id, title: x.title, body: x.body, tags: x.tags, category_source: x.category_source, ai_meta: x.ai_meta }));
    },
    async categories(userId) {
      return cats.filter((c) => c.user_id === userId).map(({ user_id: _, ...c }) => c);
    },
    async createCategory(userId, c) {
      if (cats.some((x) => x.user_id === userId && x.deleted_at === null && x.name.toLowerCase() === c.name.toLowerCase())) throw new Error('23505');
      cats.push({ ...c, user_id: userId, deleted_at: null, merged_into: null });
    },
    async writeNote(userId, noteId, patch: NotePatch, manual) {
      const x = notes.find((n) => n.id === noteId && n.user_id === userId && n.ai_status === 'pending');
      if (!x || (manual ? x.category_source !== 'manual' : x.category_source === 'manual')) return;
      Object.assign(x, patch);
    },
    async writeHeartbeat(d) { heartbeats.push(d); },
  };
  return { store, heartbeats, notes, cats };
}

/** 额度：key → 次数；refunds 记退回 */
export function fakeQuota() {
  const used = new Map<string, number>();
  const refunds: string[] = [];
  const q: QuotaStore = {
    async take(key, limit) {
      const n = (used.get(key) ?? 0) + 1;
      if (n > limit) return null;
      used.set(key, n);
      return n;
    },
    async refund(key) { refunds.push(key); used.set(key, Math.max(0, (used.get(key) ?? 0) - 1)); },
  };
  return { q, used, refunds };
}

export const cassette = (...names: string[]): Cassette => ({
  v: 1, provider: 'gemini', origin: 'handmade', note: '拼接',
  entries: names.flatMap((n) => loadCassette(new URL(`../ai/replay/cassettes/${n}.json`, import.meta.url)).entries),
} as Cassette);

export function setup(o: {
  notes: Note[]; cats?: (Category & { user_id: string })[]; cassettes?: string[]; consent?: (u: string) => Promise<boolean>;
  usable?: (u: string) => Promise<boolean>; cfg?: Partial<AiConfig>; exhaustedUntil?: number | null; secret?: string;
}) {
  const db = fakeDb(o.notes, o.cats ?? []);
  const quota = fakeQuota();
  const rp: Replay = replay(cassette(...(o.cassettes ?? [])));
  const logs: string[] = [];
  let exhausted = o.exhaustedUntil ?? null;
  let ids = 0;
  const deps: Deps = {
    cronSecret: o.secret ?? SECRET,
    store: db.store,
    isUsable: o.usable ?? (async () => true),
    consent: o.consent ?? (async () => true),
    config: async () => ({ provider: 'gemini', model: REPLAY_MODEL, per_user_daily: 50, global_daily: 500, ...o.cfg }),
    provider: () => new GeminiProvider(REPLAY_MODEL, REPLAY_KEY, rp.fetch),
    quota: quota.q,
    exhaustedUntil: async () => exhausted,
    markExhausted: async (u) => { exhausted = u; },
    logic: { classifyByRules, normalize: normalizeForSearch },
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    now: () => NOW,
    log: (c) => logs.push(c),
  };
  const call = (init: RequestInit = {}) =>
    handle(new Request('http://x/ai-classify', { method: 'POST', headers: { 'x-cron-secret': SECRET }, ...init }), deps);
  return { deps, db, quota, rp, logs, call, get exhausted() { return exhausted; } };
}
