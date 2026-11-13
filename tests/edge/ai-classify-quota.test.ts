// ai-classify 的额度、重试和公平取数（TC-B4-06；代码审查 11-10 必改 1、2）。替身见 ai-classify-fakes.ts。
import { describe, expect, it } from 'vitest';
import { BATCH_PER_USER, handle, SCAN_USERS } from '../../supabase/functions/ai-classify/core.ts';
import { globalQuotaKey, userQuotaKey } from '../../supabase/functions/_shared/ai/gate.ts';
import { MAX_TRIES } from '../../supabase/functions/ai-classify/write.ts';
import { SECRET, NOW, A, B, note, cat, setup } from './ai-classify-fakes.ts';

describe('ai-classify：额度（TC-B4-06）', () => {
  it('谷歌额度用完：退回两次、写 exhausted_until，这批记 rule 带 retry；后面的人不再送', async () => {
    const notes = [note('a1', A, '超市'), note('b1', B, '机票')];
    const s = setup({ notes, cats: [cat('c', A, '购物')], cassettes: ['quota'] });
    const r = await s.call();
    expect(s.rp.calls).toBe(1);
    expect(s.quota.refunds).toHaveLength(2);
    expect(s.exhausted).toBeGreaterThan(NOW);
    expect([notes[0]?.ai_status, notes[0]?.category_id, notes[0]?.ai_meta]).toEqual(['rule', 'c', { prompt: 'classify.v2', tries: 0, retry: 'quota' }]);   // 额度用完不计次数
    expect(notes[1]?.ai_status).toBe('pending');
    expect((await r.json()).quota_hit).toBe(true);
  });
  it('额度没恢复：不重排、不送；恢复以后的第一轮把 retry 的重新排队再送', async () => {
    const notes = [note('a1', A, '超市', { ai_status: 'rule', ai_meta: { tries: 1, retry: 'quota' } })];
    const still = setup({ notes, exhaustedUntil: NOW + 1000 });
    await still.call();
    expect([notes[0]?.ai_status, still.rp.calls]).toEqual(['rule', 0]);
    const back = setup({ notes, cats: [cat('c-shop', A, '购物')], exhaustedUntil: NOW - 1000, cassettes: ['classify-ok'] });
    const r = await back.call();
    expect([(await r.json()).requeued, back.rp.calls, notes[0]?.ai_status, notes[0]?.category_id]).toEqual([1, 1, 'done', 'c-shop']);
  });
  it(`出错（服务商 500、超时、坏输出）也记 rule 带 retry；满 ${MAX_TRIES} 次不再重排`, async () => {
    for (const c of ['http-500', 'timeout', 'bad-not-json']) {
      const notes = [note('a1', A, '超市', { ai_meta: { tries: MAX_TRIES - 1, retry: 'error' } })];
      const s = setup({ notes, cassettes: [c] });
      await s.call();
      expect(notes[0]?.ai_meta, c).toEqual({ prompt: 'classify.v2', tries: MAX_TRIES, retry: null });
      expect(s.exhausted, c).toBeNull();
    }
  }, 20_000);
  it(`出错一共试 ${MAX_TRIES} 次（含第一次）：第 ${MAX_TRIES} 次失败后 retry 为 null，额度恢复后也不再排队`, async () => {
    const notes = [note('a1', A, '超市', { ai_meta: { tries: 1, retry: 'error' } })];
    const s = setup({ notes, cassettes: ['http-500', 'http-500'] });
    await s.call();   // 第 2 次
    expect(notes[0]?.ai_meta).toEqual({ prompt: 'classify.v2', tries: 2, retry: 'error' });
    await s.call();   // 重排后第 3 次
    expect(notes[0]?.ai_meta).toEqual({ prompt: 'classify.v2', tries: MAX_TRIES, retry: null });
    const again = setup({ notes, cassettes: ['classify-ok'] });
    const body = await (await again.call()).json();
    expect([body.requeued, again.rp.calls, notes[0]?.ai_status]).toEqual([0, 0, 'rule']);
  }, 20_000);
  it('额度用完不计次数：已经试过 2 次的再碰到额度用完，tries 不变、retry 记 quota', async () => {
    const notes = [note('a1', A, '超市', { ai_meta: { tries: 2, retry: 'error' } })];
    const s = setup({ notes, cassettes: ['quota'] });
    await s.call();
    expect(notes[0]?.ai_meta).toEqual({ prompt: 'classify.v2', tries: 2, retry: 'quota' });
  });
  it('公平取数（代码审查 11-10 必改 1）：A 堆了 400 条、额度用完，B 后来的 1 条照样分到；A 每轮只占一个位置', async () => {
    const notes = [...Array.from({ length: 400 }, (_, i) => note(`a${i}`, A, `超市 ${i}`)), note('b1', B, '东京机票')];
    const s = setup({ notes, cats: [cat('c-shop', B, '购物')], cassettes: ['classify-ok'] });
    s.quota.used.set(userQuotaKey(A, NOW), 50);   // A 今天的额度用完了
    const body = await (await s.call()).json();
    expect([s.rp.calls, notes[400]?.ai_status, body.users, body.skipped]).toEqual([1, 'done', 2, BATCH_PER_USER]);
    expect(notes.filter((n) => n.user_id === A && n.ai_status === 'pending')).toHaveLength(400);
  });
  it(`一轮最多取 ${SCAN_USERS} 个人；送不了 AI 的人不占名额`, async () => {
    const notes = Array.from({ length: SCAN_USERS + 5 }, (_, i) => note(`n${i}`, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 'x'));
    const s = setup({ notes, consent: async () => false });
    const body = await (await s.call()).json();
    expect([body.users, notes.filter((n) => n.ai_status === 'rule').length]).toEqual([SCAN_USERS, SCAN_USERS]);
  });
  it('每人每天用完：留在 pending 等明天，不送；全项目用完：退回个人那一次，这一轮后面的人都不送', async () => {
    const own = setup({ notes: [note('a1', A, '超市')], cfg: { per_user_daily: 0 } });
    await own.call();
    expect([own.rp.calls, own.db.notes[0]?.ai_status]).toEqual([0, 'pending']);
    const all = setup({ notes: [note('a1', A, '超市'), note('b1', B, '机票')], cfg: { global_daily: 0 } });
    await all.call();
    expect([all.rp.calls, all.quota.refunds.length, all.logs]).toEqual([0, 1, ['global_quota_out']]);
  });
  it('扣了个人额度、全项目那一下出错（超时、断线）：退回个人那一次，这批不送 AI；全项目那一下扣没扣上不知道，不退', async () => {
    const s = setup({ notes: [note('a1', A, '超市')] });
    const take = s.quota.q.take.bind(s.quota.q);
    s.deps.quota = { ...s.quota.q, take: async (k, l) => { if (k === globalQuotaKey(NOW)) throw new Error('timeout'); return take(k, l); } };
    await s.call();
    expect([s.rp.calls, s.quota.refunds, s.logs]).toEqual([0, [userQuotaKey(A, NOW)], ['quota_failed']]);
    expect(s.quota.used.get(userQuotaKey(A, NOW))).toBe(0);
  });
  it('AI 没配好（模型没配、密钥没配）：能送的人留在 pending', async () => {
    const s = setup({ notes: [note('a1', A, '超市')] });
    await handle(new Request('http://x', { method: 'POST', headers: { 'x-cron-secret': SECRET } }), { ...s.deps, provider: () => null });
    expect([s.db.notes[0]?.ai_status, s.rp.calls, s.logs]).toEqual(['pending', 0, ['ai_not_configured']]);
  });
});
