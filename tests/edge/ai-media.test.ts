// ai-media（B4b-2 识图；架构 5.13 第 5 点“cron 函数 ai-media”、第 8 点用量表）：cron 鉴权、逐人判可用和同意、隐私记不识别、
// 读缩略图、全项目 70% 让路、每人每天张数、成功写回、失败退避和 failed、谷歌额度用完、心跳
import { describe, expect, it } from 'vitest';
import { nextPacificMidnight } from '../../supabase/functions/_shared/ai/gate.ts';
import type { AiRequest, AiResult, AIProvider } from '../../supabase/functions/_shared/ai/provider.ts';
import { noteFileThumbPath, noteImagePath } from '../../shared/logic/files/media-path.ts';
import {
  BACKOFF_MS, BATCH, type Deps, globalShare, handle, type Heartbeat, IMAGE_MAX_BYTES, LATER_MS, MAX_CALLS, MAX_TRIES, type MediaItem, mediaKey,
  readMediaDefault, ROUND_BUDGET_MS, UNLIMITED, VAULT_LATER_MS,
} from '../../supabase/functions/ai-media/core.ts';
import { cleanTags, cleanText, DESC_MAX, mediaRequest, readResults, TAGS_MAX } from '../../supabase/functions/ai-media/request.ts';
import { PROMPT_VERSION, TASK_PARAMS } from '../../supabase/functions/_shared/ai/params.ts';
import { A, B, FakeR2, T0, uuid } from '../functions/vault-fakes.ts';

const SECRET = 'c'.repeat(40);
const N = uuid(100);
const img = (n: number, over: Partial<MediaItem> = {}): MediaItem => ({
  id: uuid(n), note_id: N, bucket: 'images', has_thumb: true, tries: 0, note_private: false, note_gone: false, ...over,
});
const ok = (results: unknown): AiResult => ({ ok: true, json: { results }, raw: '' });

type Mark = { uid: string; ids: string[]; what: string; at?: number; bump?: boolean; tries?: number };

function world(opts: {
  items?: Map<string, MediaItem[]>; consent?: (u: string) => boolean; usable?: (u: string) => boolean; ai?: (req: AiRequest) => AiResult;
  globalDaily?: number | null; mediaDaily?: number | null | undefined; exhausted?: number | null; noObj?: boolean; consentCalls?: { n: number };
} = {}) {
  const items = opts.items ?? new Map([[A, [img(1)]]]);
  const r2 = new FakeR2();
  if (!opts.noObj) for (const [u, list] of items) for (const it of list) r2.objs.set(`images/${noteFileThumbPath(u, it.note_id, it.id)}`, { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/webp' });
  const marks: Mark[] = [];
  const beats: Heartbeat[] = [];
  const logs: string[] = [];
  const reqs: AiRequest[] = [];
  const counters = new Map<string, number>();
  const refunds: string[] = [];
  const exhaustedAt: number[] = [];
  let ms = T0;
  const provider: AIProvider = {
    name: 'gemini', model: 'm',
    async generate(req) {
      reqs.push(req);
      return opts.ai ? opts.ai(req) : ok(req.parts.slice(1).map((_, i) => ({ i, desc: `图${i}`, tags: ['证件', '신분증'] })));
    },
  };
  const deps: Deps = {
    cronSecret: SECRET,
    store: {
      users: async () => [...items.keys()],
      items: async (u, limit) => (items.get(u) ?? []).slice(0, limit),
      async later(uid, ids, at, bump) { marks.push({ uid, ids: [...ids], what: 'later', at, bump }); },
      async parkAll(uid, at) { marks.push({ uid, ids: [], what: 'park', at }); },
      async skipConsent(uid) { marks.push({ uid, ids: [], what: 'consent' }); return (items.get(uid) ?? []).map((x) => x.id); },
      async unskip(uid, ids) { marks.push({ uid, ids: [...ids], what: 'unskip' }); },
      async skipOther(uid, ids) { marks.push({ uid, ids: [...ids], what: 'other' }); },
      async fail(uid, id, tries) { marks.push({ uid, ids: [id], what: 'failed', tries }); },
      async done(uid, id, desc, tags) { marks.push({ uid, ids: [id], what: `done:${desc}:${tags.join(',')}` }); return true; },
      async heartbeat(d) { beats.push(d); },
    },
    r2,
    isUsable: async (u) => (opts.usable ? opts.usable(u) : true),
    consent: async (u) => { if (opts.consentCalls) opts.consentCalls.n += 1; return opts.consent ? opts.consent(u) : true; },
    config: async () => ({ ai: { provider: 'gemini', model: 'm', per_user_daily: 50, global_daily: opts.globalDaily === undefined ? 1000 : opts.globalDaily }, mediaDailyDefault: 40 }),
    provider: () => provider,
    quota: {
      async take(k, limit) { const n = (counters.get(k) ?? 0) + 1; if (n > limit) return null; counters.set(k, n); return n; },
      async refund(k) { refunds.push(k); counters.set(k, Math.max(0, (counters.get(k) ?? 0) - 1)); },
    },
    async takeRate(k, limit) { const n = (counters.get(k) ?? 0) + 1; if (n > limit) return false; counters.set(k, n); return true; },
    mediaDaily: async () => opts.mediaDaily,
    locale: async (u) => (u === B ? 'ko-KR' : 'zh-CN'),
    exhaustedUntil: async () => opts.exhausted ?? null,
    async markExhausted(t) { exhaustedAt.push(t); },
    path: (u, n, id, thumb) => (thumb ? noteFileThumbPath(u, n, id) : noteImagePath(u, n, id)),
    now: () => ms,
    log: (c) => logs.push(c),
  };
  return { deps, r2, marks, beats, logs, reqs, counters, refunds, exhaustedAt, advance: (d: number) => { ms += d; } };
}

const cron = (secret = SECRET) => new Request('http://x/ai-media', { method: 'POST', headers: { 'x-cron-secret': secret }, body: '{}' });

describe('ai-media', () => {
  it('密钥不对 401；GET 405；没配 R2 500', async () => {
    const w = world();
    expect((await handle(cron('x'.repeat(40)), w.deps)).status).toBe(401);
    expect((await handle(new Request('http://x', { method: 'GET' }), w.deps)).status).toBe(405);
    w.deps.r2 = null;
    expect((await handle(cron(), w.deps)).status).toBe(500);
    expect(w.reqs).toHaveLength(0);
  });

  it('正常：读缩略图（按 user_id、note_id、id 拼路径）、一次请求、写 done（描述 + 中韩标签）、扣全项目和每人各 1、写心跳', async () => {
    const w = world({ items: new Map([[A, [img(1), img(2)]]]) });
    const r = await handle(cron(), w.deps);
    expect(r.status).toBe(200);
    expect(w.reqs).toHaveLength(1);
    const req = w.reqs[0]!;
    expect(req.parts[0]).toEqual({ text: '<data>{"images":[0,1]}</data>' });
    expect(req.parts.slice(1).map((p) => ('inlineData' in p ? p.inlineData.mimeType : ''))).toEqual(['image/webp', 'image/webp']);
    expect(req.system).toContain('简体中文');
    expect(w.marks).toEqual([
      { uid: A, ids: [uuid(1)], what: 'done:图0:证件,신분증' },
      { uid: A, ids: [uuid(2)], what: 'done:图1:证件,신분증' },
    ]);
    expect(w.counters.get(mediaKey(A, T0))).toBe(2);
    expect([...w.counters.entries()].find(([k]) => k.startsWith('ai:global:'))?.[1]).toBe(1);
    expect(w.beats[0]).toMatchObject({ users: 1, images: 2, done: 2, calls: 1, quota_hit: false });
  });

  it('韩文界面：描述用韩文写', async () => {
    const w = world({ items: new Map([[B, [img(1)]]]) });
    await handle(cron(), w.deps);
    expect(w.reqs[0]?.system).toContain('韩文');
  });

  it('没有缩略图读原图；原图超过上限写 skip/other、不送', async () => {
    const w = world({ items: new Map([[A, [img(1, { has_thumb: false }), img(2, { has_thumb: false })]]]), noObj: true });
    w.r2.objs.set(`images/${noteImagePath(A, N, uuid(1))}`, { bytes: new Uint8Array(10), contentType: 'image/webp' });
    w.r2.objs.set(`images/${noteImagePath(A, N, uuid(2))}`, { bytes: new Uint8Array(IMAGE_MAX_BYTES + 1), contentType: 'image/webp' });
    await handle(cron(), w.deps);
    expect(w.reqs[0]?.parts).toHaveLength(2);
    expect(w.marks).toContainEqual({ uid: A, ids: [uuid(2)], what: 'other' });
    expect(w.marks.some((m) => m.what.startsWith('done') && m.ids[0] === uuid(1))).toBe(true);
  });

  it('隐私记的图（vault-images 或所在随手记 is_private）推后 30 天、不读不送；在“最近删除”里的推后 1 天', async () => {
    const w = world({ items: new Map([[A, [img(1, { bucket: 'vault-images' }), img(2, { note_private: true }), img(3, { note_gone: true })]]]) });
    await handle(cron(), w.deps);
    expect(w.reqs).toHaveLength(0);
    expect(w.marks).toEqual([
      { uid: A, ids: [uuid(1), uuid(2)], what: 'later', at: T0 + VAULT_LATER_MS, bump: false },
      { uid: A, ids: [uuid(3)], what: 'later', at: T0 + LATER_MS, bump: false },
    ]);
  });

  it('TC-B1-109 ai-media：管理员停用（disabled_at 有值）的账号跳过', async () => {
    const w = world({ items: new Map([[A, [img(1)]], [B, [img(2)]]]), usable: (u) => u !== A });
    await handle(cron(), w.deps);
    expect(w.marks[0]).toEqual({ uid: A, ids: [uuid(1)], what: 'later', at: T0 + LATER_MS, bump: false });
    expect(w.marks.filter((m) => m.what.startsWith('done')).map((m) => m.uid)).toEqual([B]);
    expect(w.reqs).toHaveLength(1);
  });
  it('TC-B1-109 ai-media：注销冷静期（disabled_reason = deletion）的账号跳过', async () => {
    const w = world({ usable: () => false });
    await handle(cron(), w.deps);
    expect(w.reqs).toHaveLength(0);
    expect(w.beats[0]).toMatchObject({ parked: 1, done: 0 });
  });

  it('没同意 / 关了 AI：这个人全部 pending 写 skip/consent，不读图、不扣额度；别人照常', async () => {
    const w = world({ items: new Map([[A, [img(1)]], [B, [img(2)]]]), consent: (u) => u === B });
    await handle(cron(), w.deps);
    expect(w.marks[0]).toEqual({ uid: A, ids: [], what: 'consent' });
    expect(w.counters.get(mediaKey(A, T0))).toBeUndefined();
    expect(w.reqs).toHaveLength(1);
    expect(w.beats[0]).toMatchObject({ consent: 1, done: 1 });
  });

  it('写 skip 后再查一次同意：查和写之间刚打开了 AI，把刚写的几张改回 pending（整块评审第 2 条）', async () => {
    const calls = { n: 0 };
    const w = world({ items: new Map([[A, [img(1), img(2)]]]), consent: () => calls.n > 1, consentCalls: calls });
    await handle(cron(), w.deps);
    expect(w.marks).toEqual([{ uid: A, ids: [], what: 'consent' }, { uid: A, ids: [uuid(1), uuid(2)], what: 'unskip' }]);
    expect(w.logs).toContain('consent_raced');
    expect(w.beats[0]).toMatchObject({ consent: 0 });
  });

  it('全项目用到 global_daily 的 70% 让路：本轮不送、记 global_yield；global_daily 没配按 0（一律不送）', async () => {
    expect(globalShare(1000)).toBe(700);
    expect(globalShare(null)).toBe(0);
    const w = world({ globalDaily: null });
    await handle(cron(), w.deps);
    expect(w.reqs).toHaveLength(0);
    expect(w.beats[0]).toMatchObject({ global_yield: true });
    expect(w.marks).toEqual([]);
  });

  it('每人每天：先扣 1 张看有没有余额，识别成了按张数补扣（到上限停）；一张都扣不上 → 退回全项目那一次、全部 pending 推到太平洋午夜', async () => {
    const w = world({ items: new Map([[A, [img(1), img(2), img(3)]]]), mediaDaily: 2 });
    await handle(cron(), w.deps);
    expect(w.reqs[0]?.parts).toHaveLength(4);   // <data> + 3 张（同一批最多多识别 BATCH − 1 张）
    expect(w.counters.get(mediaKey(A, T0))).toBe(2);
    const v = world({ mediaDaily: 0 });
    await handle(cron(), v.deps);
    expect(v.reqs).toHaveLength(0);
    expect(v.refunds).toHaveLength(1);
    expect(v.marks).toEqual([{ uid: A, ids: [], what: 'park', at: nextPacificMidnight(T0) }]);
  });

  it('user_limits 没有这一行用 app_config 默认 40；写着 null（负责人）不设上限、照样计数', async () => {
    expect(readMediaDefault({ media_daily_default: 7 })).toBe(7);
    expect(readMediaDefault({ media_daily_default: -1 })).toBe(40);
    expect(readMediaDefault(null)).toBe(40);
    const seen: number[] = [];
    const w = world({ mediaDaily: null });
    const take = w.deps.takeRate;
    w.deps.takeRate = async (k, limit, win) => { seen.push(limit); return take(k, limit, win); };
    await handle(cron(), w.deps);
    expect(seen).toEqual([UNLIMITED]);
    expect(w.counters.get(mediaKey(A, T0))).toBe(1);
  });

  it('出错：退回全项目那一次、每人只损失先扣的 1 张；ai_tries + 1 退避 10 分钟；第 2 次 1 小时；第 3 次 failed', async () => {
    const fail = (): AiResult => ({ ok: false, reason: 'error', status: 500 });
    const w = world({ items: new Map([[A, [img(1), img(2, { tries: 1 }), img(3, { tries: 2 })]]]), ai: fail });
    await handle(cron(), w.deps);
    expect(w.refunds).toHaveLength(1);
    expect(w.counters.get(mediaKey(A, T0))).toBe(1);
    expect(w.marks).toEqual([
      { uid: A, ids: [uuid(1)], what: 'later', at: T0 + BACKOFF_MS[0], bump: true },
      { uid: A, ids: [uuid(2)], what: 'later', at: T0 + BACKOFF_MS[1], bump: true },
      { uid: A, ids: [uuid(3)], what: 'failed', tries: MAX_TRIES },
    ]);
    expect(w.logs).toContain('ai_error');
    expect(w.beats[0]).toMatchObject({ retry: 2, failed: 1 });
  });

  it('模型漏了一张、描述清完是空的：这一张按失败退避，别的照写', async () => {
    const w = world({ items: new Map([[A, [img(1), img(2)]]]), ai: () => ok([{ i: 0, desc: '一张收据', tags: [] }, { i: 1, desc: '   ', tags: [] }]) });
    await handle(cron(), w.deps);
    expect(w.marks).toEqual([
      { uid: A, ids: [uuid(1)], what: 'done:一张收据:' },
      { uid: A, ids: [uuid(2)], what: 'later', at: T0 + BACKOFF_MS[0], bump: true },
    ]);
    expect(w.logs).toContain('ai_partial n=1');
  });

  it('对象不在（还没传上）：按失败退避，不送；全项目那一次退回、每人不扣', async () => {
    const w = world({ noObj: true });
    await handle(cron(), w.deps);
    expect(w.reqs).toHaveLength(0);
    expect(w.marks).toEqual([{ uid: A, ids: [uuid(1)], what: 'later', at: T0 + BACKOFF_MS[0], bump: true }]);
    expect(w.refunds).toHaveLength(1);
    expect(w.counters.get(mediaKey(A, T0))).toBeUndefined();
  });

  it('缩略图不在再读原图', async () => {
    const w = world({ noObj: true });
    w.r2.objs.set(`images/${noteImagePath(A, N, uuid(1))}`, { bytes: new Uint8Array(10), contentType: 'image/webp' });
    await handle(cron(), w.deps);
    expect(w.reqs).toHaveLength(1);
    expect(w.marks[0]?.what.startsWith('done')).toBe(true);
  });

  it('扣上全项目以后读库出错：退回全项目那一次，日志带安全码', async () => {
    const w = world();
    w.deps.mediaDaily = async () => { throw new Error('db:user_limits'); };
    await handle(cron(), w.deps);
    expect(w.reqs).toHaveLength(0);
    expect(w.refunds).toHaveLength(1);
    expect(w.logs).toContain('user_failed:db:user_limits');
    w.deps.mediaDaily = async () => { throw new Error('护照 M12345678 bad'); };
    await handle(cron(), w.deps);
    expect(w.logs.at(-1)).toBe('user_failed');
  });

  it('谷歌额度用完（429）：退回全项目、写 exhausted_until、不计 ai_tries、本轮停（后面的人不送）', async () => {
    const w = world({ items: new Map([[A, [img(1)]], [B, [img(2)]]]), ai: () => ({ ok: false, reason: 'quota', quotaKind: 'day' }) });
    await handle(cron(), w.deps);
    expect(w.reqs).toHaveLength(1);
    expect(w.refunds).toHaveLength(1);
    expect(w.exhaustedAt).toEqual([nextPacificMidnight(T0)]);
    expect(w.marks).toEqual([]);
    expect(w.beats[0]).toMatchObject({ quota_hit: true });
  });

  it('exhausted_until 没过：整轮不做、只写心跳', async () => {
    const w = world({ exhausted: T0 + 60_000 });
    await handle(cron(), w.deps);
    expect([w.reqs.length, w.marks.length]).toEqual([0, 0]);
    expect(w.beats[0]).toMatchObject({ quota_hit: true, users: 0 });
  });

  it('一轮最多 MAX_CALLS 次 AI；墙钟预算到了不再开始下一个人', async () => {
    const many = new Map<string, MediaItem[]>(Array.from({ length: MAX_CALLS + 2 }, (_, i) => [uuid(500 + i), [img(i + 1)]]));
    const w = world({ items: many });
    await handle(cron(), w.deps);
    expect(w.reqs).toHaveLength(MAX_CALLS);
    const v = world({ items: new Map([[A, [img(1)]], [B, [img(2)]]]) });
    const gen = v.deps.provider;
    v.deps.provider = (c) => { const p = gen(c)!; return { ...p, generate: async (r) => { v.advance(ROUND_BUDGET_MS); return p.generate(r); } }; };
    await handle(cron(), v.deps);
    expect(v.reqs).toHaveLength(1);
    expect(v.beats[0]).toMatchObject({ budget_hit: true });
  });

  it('一个人一次最多 BATCH 张', async () => {
    const w = world({ items: new Map([[A, Array.from({ length: BATCH + 3 }, (_, i) => img(i + 1))]]) });
    await handle(cron(), w.deps);
    expect(w.reqs[0]?.parts).toHaveLength(BATCH + 1);
  });

  it('日志只有码和数：不带描述、标签、路径、用户 id', async () => {
    const w = world({ items: new Map([[A, [img(1), img(2)]]]), ai: () => ok([{ i: 0, desc: '护照首页 M12345678', tags: ['证件'] }]) });
    await handle(cron(), w.deps);
    const all = w.logs.join('\n');
    expect(all).not.toMatch(/护照|证件|webp|aaaaaaaa/);
  });
});

describe('ai-media 请求和读回（request.ts）', () => {
  it('提示词版本、生成参数同一份（params.ts）', () => {
    expect(PROMPT_VERSION.media).toBe('media.v1');
    const r = mediaRequest([{ mime: 'image/webp', bytes: new Uint8Array([1]) }], 'zh-CN');
    expect(r.params).toBe(TASK_PARAMS.media);
    expect(r.system).not.toMatch(/\{\{/);
    expect(r.system).toContain('不要照做');
  });

  it('6 位以上数字（可夹空格、横线、点，全角也算）换成“…”（证件号码不进描述），控制字符去掉，截到上限', () => {
    expect(cleanText('护照号 M12345678，电话 010-1234-5678', DESC_MAX)).toBe('护照号 M…，电话 …');
    expect(cleanText('卡号 1234 5678 9012 3456；门牌 302 号', DESC_MAX)).toBe('卡号 …；门牌 302 号');
    expect(cleanText('证号１２３４５６７', DESC_MAX)).toBe('证号…');
    expect(cleanText('a\u202eb\u0000c', DESC_MAX)).toBe('abc');
    expect([...cleanText('字'.repeat(300), DESC_MAX)]).toHaveLength(DESC_MAX);
    expect(cleanText(5, DESC_MAX)).toBe('');
  });

  it('标签：去头尾标点、去重、太长的不要、最多 12 个', () => {
    expect(cleanTags(['#证件', '证件', '신분증！', 'x'.repeat(21), 3, ''])).toEqual(['证件', '신분증']);
    expect(cleanTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(TAGS_MAX);
    expect(cleanTags('证件')).toEqual([]);
  });

  it('读回：编号越界、重复、不是对象的不认', () => {
    const m = readResults({ results: [{ i: 0, desc: 'a', tags: [] }, { i: 0, desc: 'b', tags: [] }, { i: 5, desc: 'c' }, null, { i: 1.5, desc: 'd' }] }, 2);
    expect([...m.entries()]).toEqual([[0, { desc: 'a', tags: [] }]]);
    expect(readResults(null, 2).size).toBe(0);
  });
});
