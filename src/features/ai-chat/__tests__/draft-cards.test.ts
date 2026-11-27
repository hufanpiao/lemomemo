// AI 助手“要记成这样吗”卡片的状态（hooks/useChat.ts 的 cardsOf、saveCard、pickCard；data/chat-api.ts 的 draft）：11-24 负责人“在 AI 里输入也可以记录日程跟待办”
// • 拿到 plus 的拆和存才带 draft；没登记先等录音那一块（waitRecorder），等不到不带、对话照问
// • 回包的几段原话按本机规则拆成卡片；raw 存用户问的那一句
// • 过去的月日先问（confirm）：没选不存，选了按 confirm 改日子；不存在的日子、重复说法在卡片上标出；一张都没拆出来时 draftMiss
// • saveCard：busy → 记到哪一条；不重复存；没存上可以再点
import { describe, expect, it, vi } from 'vitest';
import { parseSplit, type ParseResult } from '../../../../shared/logic/parse/parse-split.ts';
import type { FnDeps } from '../../../platform/fn-call.ts';
import { askChat, type ChatResult } from '../data/chat-api.ts';
import type { ChatRecorder } from '../hooks/chat-open.ts';
import { cardsOf, createChat, type ChatDeps } from '../hooks/useChat.ts';

const OK: ChatResult = { ok: true, answer: '好。', refs: [], searched: [], found: 0, webs: 0, memories: [], drafts: [], quotaLeft: 40 };
// 2025-11-22 首尔
const T0 = 1_763_800_000_000;

// 拆用真的本机规则（shared parseSplit，同 plus 的 planLocal）
const plan = (text: string): ParseResult => parseSplit(text, T0, 'Asia/Seoul', 'zh', [], { features: ['event', 'todo'] });
/** 同 plus 的 applyConfirm */
const confirm: ChatRecorder['confirm'] = (it, choice) => {
  if (it.confirm === null) return it;
  return it.kind === 'event' ? { ...it, date: it.confirm[choice], confirm: null } : { ...it, due: it.confirm[choice], confirm: null };
};
const fakeRec = (save: ChatRecorder['save'] = async (it) => ({ table: it.kind === 'event' ? 'events' : 'todos', id: 'r1' })): ChatRecorder => ({
  plan, confirm, save: vi.fn(save),
});
const mkRec = (r: ChatResult, rec: ChatRecorder | null, wait: ChatDeps['waitRecorder'] = async () => rec) => {
  const ask = vi.fn<ChatDeps['ask']>().mockResolvedValue(r);
  const usage = vi.fn<ChatDeps['usage']>().mockResolvedValue({ ok: false, err: 'x' } as never);
  return { c: createChat({ ask, usage, now: () => T0, tz: () => 'Asia/Seoul', recorder: () => rec, waitRecorder: wait }), ask };
};
const SAID = '帮我记一下：明天下午三点和客户开会，周五前交报告';
const WITH: ChatResult = { ...OK, answer: '整理好了。', drafts: ['明天下午三点和客户开会', '周五前交报告'] };
const cards = (c: ReturnType<typeof mkRec>['c']) => {
  const t = c.get().turns[1];
  return t?.k === 'ai' ? t.cards : [];
};

describe('记日程待办的确认卡片（11-24）', () => {
  it('拿到拆和存才带 draft；回包的几段原话在回答到的时候拆成卡片；raw 存用户问的那一句，不存模型整理过的那段', async () => {
    const rec = fakeRec();
    const a = mkRec(WITH, rec);
    await a.c.send(SAID, 'zh-CN');
    expect(a.ask.mock.calls[0]?.[0]).toMatchObject({ draft: true });
    expect(cards(a.c).map((x) => [x.item.kind, x.item.title, x.item.confirm, x.warn, x.st, x.raw])).toEqual([
      ['event', '和客户开会', null, null, 'idle', SAID],
      ['todo', '交报告', null, null, 'idle', SAID],
    ]);
    const b = mkRec(OK, null);
    await b.c.send('x', 'zh-CN');
    expect(b.ask.mock.calls[0]?.[0]).not.toHaveProperty('draft');
    expect(cardsOf(['a'], null, 'a')).toEqual([]);
  });

  it('没登记时先等录音那一块登记（waitRecorder），等到了照样带 draft；等不到不带，对话照问', async () => {
    const rec = fakeRec();
    let got: ChatRecorder | null = null;
    const ask = vi.fn<ChatDeps['ask']>().mockResolvedValue(WITH);
    const usage = vi.fn<ChatDeps['usage']>().mockResolvedValue({ ok: false, err: 'x' } as never);
    const wait = vi.fn(async () => {
      got = rec;
      return rec;
    });
    const c = createChat({ ask, usage, now: () => T0, tz: () => 'Asia/Seoul', recorder: () => got, waitRecorder: wait });
    await c.send(SAID, 'zh-CN');
    expect(wait).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]?.[0]).toMatchObject({ draft: true });
    expect(cards(c)).toHaveLength(2);
    await c.send(SAID, 'zh-CN');
    expect(wait).toHaveBeenCalledTimes(1);   // 登记上以后不再等
    const none = mkRec(OK, null, async () => null);
    await none.c.send('x', 'zh-CN');
    expect(none.ask).toHaveBeenCalledTimes(1);
    expect(none.ask.mock.calls[0]?.[0]).not.toHaveProperty('draft');
  });

  it('等着录音那一块时关抽屉：不发请求，这一句换成没问到卡', async () => {
    let release: (r: ChatRecorder | null) => void = () => undefined;
    const { c, ask } = mkRec(WITH, null, () => new Promise((res) => { release = res; }));
    const p = c.send(SAID, 'zh-CN');
    c.abort();
    release(fakeRec());
    expect(await p).toBe(false);
    expect(ask).not.toHaveBeenCalled();
    expect(c.get().turns.map((t) => t.k)).toEqual(['me', 'fail']);
  });

  it('过去的月日先问（11 月说“1月5日下午三点开会”）：卡片带 confirm，没选不存；选“明年”按 confirm 改日子再存', async () => {
    const rec = fakeRec();
    const { c } = mkRec({ ...WITH, drafts: ['1月5日下午三点开会'] }, rec);
    await c.send('1月5日下午三点开会', 'zh-CN');
    const id = c.get().turns[1]?.id ?? 0;
    expect(cards(c)[0]?.item).toMatchObject({ kind: 'event', date: '2025-01-05', confirm: { past: '2025-01-05', next: '2026-01-05' } });
    expect(await c.saveCard(id, 0)).toBe(false);
    expect(rec.save).not.toHaveBeenCalled();
    c.pickCard(id, 0, 'next');
    expect(cards(c)[0]?.item).toMatchObject({ date: '2026-01-05', confirm: null });
    expect(await c.saveCard(id, 0)).toBe(true);
    expect(rec.save).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-01-05', confirm: null }), '1月5日下午三点开会');
  });

  it('拿不准的标在卡片上：不存在的日子（2月30日）、重复说法', async () => {
    const { c } = mkRec({ ...WITH, drafts: ['2月30日交房租', '每周一上午九点开例会'] }, fakeRec());
    await c.send('2月30日交房租，每周一上午九点开例会', 'zh-CN');
    expect(cards(c).map((x) => [x.item.kind, x.item.kind === 'event' ? 'date' : x.item.due, x.warn])).toEqual([
      ['todo', null, { k: 'bad_day', md: { month: 2, day: 30 } }],
      ['event', 'date', { k: 'recur' }],
    ]);
  });

  it('模型交回了要记的事、一张卡片都没拆出来：draftMiss（回答下补一行提示）', async () => {
    const rec: ChatRecorder = { ...fakeRec(), plan: () => ({ items: [], hints: { recur: false, arrange: false, bad_day: null }, doubts: ['empty'] }) };
    const { c } = mkRec(WITH, rec);
    await c.send(SAID, 'zh-CN');
    const t = c.get().turns[1];
    expect(t?.k === 'ai' ? [t.cards.length, t.draftMiss] : null).toEqual([0, true]);
    const ok = mkRec(WITH, fakeRec());
    await ok.c.send(SAID, 'zh-CN');
    const u = ok.c.get().turns[1];
    expect(u?.k === 'ai' ? u.draftMiss : null).toBe(false);
  });

  it('saveCard：busy → 记到哪一条；已记下的再点不重复存；没存上是 no，可以再点', async () => {
    let first = true;
    const rec = fakeRec(async (it) => {
      if (first) {
        first = false;
        return null;
      }
      return { table: it.kind === 'event' ? 'events' : 'todos', id: 'e9' };
    });
    const { c } = mkRec(WITH, rec);
    await c.send(SAID, 'zh-CN');
    const id = c.get().turns[1]?.id ?? 0;
    const st = (): unknown => { const t = c.get().turns[1]; return t?.k === 'ai' ? t.cards[0]?.st : null; };
    const p = c.saveCard(id, 0);
    expect(st()).toBe('busy');
    expect(await c.saveCard(id, 0)).toBe(false);   // 正在存时再点不重复存
    expect(await p).toBe(false);
    expect(st()).toBe('no');
    expect(await c.saveCard(id, 0)).toBe(true);
    expect(st()).toEqual({ table: 'events', id: 'e9' });
    expect(await c.saveCard(id, 0)).toBe(false);
    expect(rec.save).toHaveBeenCalledTimes(2);
    expect(rec.save).toHaveBeenLastCalledWith(expect.objectContaining({ title: '和客户开会' }), SAID);
  });

  it('askChat：带 draft 才在请求里写 draft: true；回包 drafts 交回，没有为空数组', async () => {
    const sent: unknown[] = [];
    const deps = (body: unknown): FnDeps => ({
      accessToken: async () => 'tok',
      fetch: (async (_u: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as FnDeps['fetch'],
      base: 'https://x.test/functions/v1',
      anonKey: 'anon',
    });
    const req = { messages: [{ role: 'user' as const, text: '明天开会' }], tz: 'Asia/Seoul', locale: 'zh-CN' };
    const sig = new AbortController().signal;
    await expect(askChat({ ...req, draft: true }, sig, deps({ answer: 'a', refs: [], searched: [], found: 0, drafts: ['明天开会'], quota_left: 3 }))).resolves.toMatchObject({ ok: true, drafts: ['明天开会'] });
    expect(sent[0]).toMatchObject({ draft: true });
    await expect(askChat(req, sig, deps({ answer: 'a', refs: [], searched: [], found: 0, quota_left: 3 }))).resolves.toMatchObject({ ok: true, drafts: [] });
    expect(sent[1]).not.toHaveProperty('draft');
  });
});
