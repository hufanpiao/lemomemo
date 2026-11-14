// ai-embed（B4b-2；架构 5.13 第 6 点“哪些需要重算：队列”、第 6 节 ai-embed 行）：cron 鉴权、逐人判同意、源头状态、去重、额度、退避、心跳
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EmbedResult } from '../../supabase/functions/_shared/ai/embed.ts';
import { exhaustedUntilFor } from '../../supabase/functions/_shared/ai/gate.ts';
import {
  BACKOFF_MS, backoffAt, type Deps, embedInput, handle, keyOf, LATER_MS, MAX_TRIES, type QItem, readEmbedConfig, ROUND_BUDGET_MS, type Src, srcText,
  VAULT_LATER_MS,
} from '../../supabase/functions/ai-embed/core.ts';
import { A, B, T0, uuid } from '../functions/vault-fakes.ts';

const V = Array.from({ length: 768 }, () => 0.01);
const SECRET = 'c'.repeat(40);
const item = (n: number, kind: QItem['kind'] = 'note', over: Partial<QItem> = {}): QItem => ({ kind, source_id: uuid(n), model: '', queued_at: 'q1', tries: 0, ...over });
const sha = async (t: string) => createHash('sha256').update(t).digest('hex');

function world(opts: {
  queue?: Map<string, QItem[]>; src?: Map<string, Src>; hashes?: Map<string, string>; embed?: EmbedResult; consent?: (u: string) => boolean;
  rateOk?: boolean;
} = {}) {
  const queue = opts.queue ?? new Map([[A, [item(1)]]]);
  const src = opts.src ?? new Map<string, Src>([[keyOf(item(1)), { state: 'ok', title: '牙医', text: '周五下午' }]]);
  const written: { uid: string; it: QItem; model: string; hash: string }[] = [];
  const settled: QItem[] = [];
  const later: { items: QItem[]; at: number; bump: boolean }[] = [];
  const beats: Record<string, number>[] = [];
  const logs: string[] = [];
  const calls: string[][] = [];
  const deps: Deps = {
    cronSecret: SECRET,
    store: {
      users: async () => [...queue.keys()],
      items: async (u) => queue.get(u) ?? [],
      sources: async () => src,
      hashes: async () => opts.hashes ?? new Map(),
      async write(uid, it, model, hash) { written.push({ uid, it, model, hash }); return true; },
      async settle(_u, items) { settled.push(...items); },
      async later(_u, items, at, bump) { later.push({ items: [...items], at, bump }); },
      async heartbeat(d) { beats.push(d); },
    },
    isUsable: async () => true,
    consent: async (u) => (opts.consent ? opts.consent(u) : true),
    config: async () => ({ embedModel: 'gemini-embedding-2', dailyGlobal: null }),
    takeRate: async () => opts.rateOk ?? true,
    embedder: () => async (texts) => { calls.push([...texts]); return opts.embed ?? { ok: true, vectors: texts.map(() => V) }; },
    sha256Hex: sha,
    now: () => T0,
    log: (c) => logs.push(c),
  };
  return { deps, written, settled, later, beats, logs, calls };
}

const cron = (secret = SECRET) => new Request('http://x/ai-embed', { method: 'POST', headers: { 'x-cron-secret': secret }, body: '{}' });

describe('ai-embed', () => {
  it('密钥不对 401；GET 405', async () => {
    const w = world();
    expect((await handle(cron('x'.repeat(40)), w.deps)).status).toBe(401);
    expect((await handle(new Request('http://x', { method: 'GET' }), w.deps)).status).toBe(405);
    expect(w.calls).toHaveLength(0);
  });

  it('正常：算一条、写向量、删队列行、写心跳', async () => {
    const w = world();
    const res = await handle(cron(), w.deps);
    expect(res.status).toBe(200);
    expect(w.calls).toEqual([['title: 牙医 | text: 周五下午']]);
    expect(w.written).toEqual([{ uid: A, it: item(1), model: 'gemini-embedding-2', hash: await sha('title: 牙医 | text: 周五下午') }]);
    expect(w.settled).toEqual([item(1)]);
    expect(w.beats[0]).toMatchObject({ users: 1, items: 1, embedded: 1 });
  });

  it('内容没变（hash 一样）：不调模型，只删队列行', async () => {
    const h = await sha(embedInput({ title: '牙医', text: '周五下午' }));
    const w = world({ hashes: new Map([[keyOf(item(1)), h]]) });
    await handle(cron(), w.deps);
    expect(w.calls).toHaveLength(0);
    expect(w.settled).toEqual([item(1)]);
    expect(w.beats[0]).toMatchObject({ same: 1, embedded: 0 });
  });

  it('源头没了、没有可算的字：只删队列行；隐私记：推后 30 天、留在队列里、不送内容', async () => {
    const q = [item(1), item(2), item(3, 'image')];
    const w = world({
      queue: new Map([[A, q]]),
      src: new Map<string, Src>([[keyOf(item(2)), { state: 'vault' }], [keyOf(item(3, 'image')), { state: 'empty' }]]),
    });
    await handle(cron(), w.deps);
    expect(w.calls).toHaveLength(0);
    expect(w.settled).toEqual([item(1), item(3, 'image')]);
    expect(w.later).toEqual([{ items: [item(2)], at: T0 + VAULT_LATER_MS, bump: false }]);
  });

  it('不同意的人：整批推后 1 天、不读源头不送；别人照常', async () => {
    const w = world({
      queue: new Map([[B, [item(5)]], [A, [item(1)]]]),
      consent: (u) => u === A,
    });
    await handle(cron(), w.deps);
    expect(w.later).toEqual([{ items: [item(5)], at: T0 + LATER_MS, bump: false }]);
    expect(w.written.map((x) => x.uid)).toEqual([A]);
  });

  it('谷歌 429：这批推到 exhaustedUntilFor（每天的到太平洋午夜、每分钟的按 retryDelay）、本轮停（后面的人不再调）', async () => {
    const minute: EmbedResult = { ok: false, reason: 'quota', status: 429, quotaKind: 'minute', retryMs: 30_000 };
    const wm = world({ embed: minute });
    await handle(cron(), wm.deps);
    expect(wm.later).toEqual([{ items: [item(1)], at: exhaustedUntilFor(T0, minute), bump: false }]);
    expect(exhaustedUntilFor(T0, minute)).toBe(T0 + 30_000);
    const w = world({ queue: new Map([[A, [item(1)]], [B, [item(2)]]]), embed: { ok: false, reason: 'quota', status: 429, quotaKind: 'day' },
      src: new Map<string, Src>([[keyOf(item(1)), { state: 'ok', title: 'a', text: 'b' }], [keyOf(item(2)), { state: 'ok', title: 'c', text: 'd' }]]) });
    await handle(cron(), w.deps);
    expect(w.calls).toHaveLength(1);
    expect(w.later).toEqual([{ items: [item(1)], at: exhaustedUntilFor(T0, { quotaKind: 'day' }), bump: false }]);
    expect(exhaustedUntilFor(T0, { quotaKind: 'day' }) - T0).toBeGreaterThan(3600_000 - 1);
  });

  it('全项目每天用完：不调模型、本轮停', async () => {
    const w = world({ rateOk: false });
    await handle(cron(), w.deps);
    expect(w.calls).toHaveLength(0);
    expect(w.logs).toContain('daily_global_out');
  });

  it('超时、出错：tries + 1，按 10 分钟、1 小时、6 小时退避', async () => {
    const w = world({ embed: { ok: false, reason: 'timeout' } });
    await handle(cron(), w.deps);
    expect(w.later).toEqual([{ items: [item(1)], at: T0 + BACKOFF_MS[0], bump: true }]);
    expect(backoffAt(0, 1)).toBe(BACKOFF_MS[1]);
    expect(backoffAt(0, 9)).toBe(BACKOFF_MS[2]);
  });

  it('出错试满 MAX_TRIES 次：删队列行、计 gave_up，不再退避', async () => {
    const last = item(1, 'note', { tries: MAX_TRIES - 1 });
    const w = world({ queue: new Map([[A, [last]]]), embed: { ok: false, reason: 'error', status: 400 } });
    await handle(cron(), w.deps);
    expect(w.settled).toEqual([last]);
    expect(w.later).toEqual([]);
    expect(w.beats[0]).toMatchObject({ gave_up: 1, failed: 0 });
  });

  it('一轮墙钟预算：到了不再开始下一个人', async () => {
    const w = world({ queue: new Map([[A, [item(1)]], [B, [item(2)]]]),
      src: new Map<string, Src>([[keyOf(item(1)), { state: 'ok', title: 'a', text: 'b' }], [keyOf(item(2)), { state: 'ok', title: 'c', text: 'd' }]]) });
    let t = T0;
    w.deps.now = () => t;
    w.deps.embedder = () => async (texts) => { t += ROUND_BUDGET_MS; return { ok: true, vectors: texts.map(() => V) }; };
    await handle(cron(), w.deps);
    expect(w.written.map((x) => x.uid)).toEqual([A]);
    expect(w.logs).toContain('round_budget');
  });

  it('写向量没成（队列行被撤回同意删掉）：不删队列行、不算 embedded', async () => {
    const w = world();
    w.deps.store!.write = async () => false;
    await handle(cron(), w.deps);
    expect(w.settled).toEqual([]);
    expect(w.beats[0]).toMatchObject({ embedded: 0 });
  });

  it('拼文字：日程带地点和备注、图片带所在随手记标题、文档只取前 2000 字；没配模型只写心跳', async () => {
    expect(srcText.event('看牙', '江南', '带医保卡')).toEqual({ title: '看牙', text: '江南\n带医保卡' });
    expect(srcText.image('一张发票', ['发票', '영수증'], '报销')).toEqual({ title: '报销', text: '一张发票\n发票 영수증' });
    expect([...srcText.file('a.pdf', '字'.repeat(3000), null, null).text]).toHaveLength(2000);
    expect(readEmbedConfig({ embed_model: 'gemini-embedding-2', embed_daily_global: 500 })).toEqual({ embedModel: 'gemini-embedding-2', dailyGlobal: 500 });
    const w = world();
    w.deps.config = async () => ({ embedModel: null, dailyGlobal: null });
    await handle(cron(), w.deps);
    expect(w.calls).toHaveLength(0);
    expect(w.beats).toHaveLength(1);
  });
});
