// 隐私记会话（data/session.ts）11-14 整块评审：第 8 条两种上锁、第 6 条 pin_wrong 带倒计时、第 14 条运行日志不带敏感内容
import { afterEach, describe, expect, it } from 'vitest';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import { held, listOk, make, NID, note, TOK, TOK2, unlocked } from './session-fakes.ts';

const locked = { ok: false, code: 'vault_locked' };

describe('第 8 条：令牌过期的上锁不作废在飞的写请求', () => {
  it('保存在路上时别的请求碰到令牌过期：保存回来也是过期 → 等解锁、重发一次，最后成功', async () => {
    const h = held();
    let saves = 0;
    const { s, calls } = await unlocked({ save: () => (++saves === 1 ? h.p : { ok: true, vault_token: TOK2, expires_at: 9e12 }), delete: () => locked });
    const p = s.save({ id: NID, title: '体检报告', body: '血压 120/80' });
    void s.remove(NID);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.get()).toMatchObject({ phase: 'locked', waiting: true });
    h.release(locked);
    await new Promise((r) => setTimeout(r, 0));
    expect((await s.unlock('1234')).ok).toBe(true);
    const r = await p;
    expect(r).toEqual({ ok: true, value: NID });
    expect(calls.filter((c) => c.action === 'save')).toHaveLength(2);
  });

  it('保存在路上时令牌过期上锁、保存回来成功：照常回成功，但锁着不收令牌、不拉明文', async () => {
    const h = held();
    const { s } = await unlocked({ save: () => h.p, delete: () => locked });
    const p = s.save({ id: NID, title: '体检报告', body: '血压 120/80' });
    void s.remove(NID);
    await new Promise((r) => setTimeout(r, 0));
    h.release({ ok: true, vault_token: TOK2, expires_at: 9e12 });
    expect(await p).toEqual({ ok: true, value: NID });
    expect(s.hasToken()).toBe(false);
    expect(s.get()).toMatchObject({ phase: 'locked', notes: null });
  });

  it('等解锁时用户取消：在飞的保存回失败（不是悄悄丢掉），也不再弹解锁', async () => {
    const h = held();
    const { s } = await unlocked({ save: () => h.p, delete: () => locked });
    const p = s.save({ id: NID, title: 't', body: 'b' });
    void s.remove(NID);
    await new Promise((r) => setTimeout(r, 0));
    h.release(locked);
    await new Promise((r) => setTimeout(r, 0));
    s.cancelWait();
    const r = await p;
    expect(r).toMatchObject({ ok: false, code: 'vault_locked' });
    expect(s.get().waiting).toBe(false);
  });

  it('读请求（list）在路上时令牌过期上锁：回来的明文照样丢', async () => {
    const h = held();
    let n = 0;
    const { s } = await unlocked({ list: () => (++n === 1 ? listOk() : h.p), delete: () => locked });
    const p = s.list();
    void s.remove(NID);
    await new Promise((r) => setTimeout(r, 0));
    h.release(listOk([note({ title: '新的' })]));
    expect((await p).ok).toBe(false);
    expect(s.get().notes).toBeNull();
  });

  it('用户主动上锁照旧作废在飞的保存（不重发）', async () => {
    const h = held();
    const { s, calls } = await unlocked({ save: () => h.p });
    const p = s.save({ id: NID, title: 't', body: 'b' });
    s.lock();
    h.release({ ok: true, vault_token: TOK2, expires_at: 9e12 });
    expect((await p).ok).toBe(false);
    expect(s.hasToken()).toBe(false);
    expect(calls.filter((c) => c.action === 'save')).toHaveLength(1);
  });
});

describe('第 22 条配合：续期被拒（超过 12 小时、或闲置过期）时没存的草稿不丢', () => {
  it('打字触发续期回 vault_locked → 等解锁；编辑页交出的草稿解锁后保存一次', async () => {
    const { s, calls, clock } = await unlocked({ renew: () => locked });
    clock.ms += 6 * 60_000;
    s.touch();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.get()).toMatchObject({ phase: 'locked', waiting: true, notes: null });
    const p = s.saveWhenUnlocked({ id: NID, title: '草稿', body: '还没存' });
    expect(calls.filter((c) => c.action === 'save')).toHaveLength(0);
    expect((await s.unlock('1234')).ok).toBe(true);
    expect(await p).toEqual({ ok: true, value: NID });
    const sent = calls.filter((c) => c.action === 'save');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.req).toMatchObject({ title: '草稿', body: '还没存' });
  });

  it('等解锁时用户主动上锁或取消：草稿丢掉，不发保存', async () => {
    const { s, calls, clock } = await unlocked({ renew: () => locked });
    clock.ms += 6 * 60_000;
    s.touch();
    await new Promise((r) => setTimeout(r, 0));
    const p = s.saveWhenUnlocked({ id: NID, title: '草稿', body: 'x' });
    s.lock();
    expect((await p).ok).toBe(false);
    expect((await s.unlock('1234')).ok).toBe(true);
    expect(calls.filter((c) => c.action === 'save')).toHaveLength(0);
  });
});

describe('第 6 条：输错的那一次带了 retry_after_s 也显示倒计时', () => {
  it('pin_wrong + retry_after_s：lockedUntil 设上；pin_locked 照旧', async () => {
    const m = make({ unlock: () => ({ ok: false, code: 'pin_wrong', left: 0, retryAfterS: 60 }) });
    await m.s.refreshStatus();
    await m.s.unlock('9999');
    expect(m.s.get()).toMatchObject({ left: 0, lockedUntil: m.clock.ms + 60_000, lastError: 'pin_wrong' });
    const m2 = make({ unlock: () => ({ ok: false, code: 'pin_locked', retryAfterS: 300 }) });
    await m2.s.refreshStatus();
    await m2.s.unlock('9999');
    expect(m2.s.get()).toMatchObject({ lockedUntil: m2.clock.ms + 300_000, lastError: 'pin_locked' });
  });
});

describe('第 14 条：运行日志', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[RL_SLOT];
  });
  const lines = (): string[] => ((globalThis as unknown as Record<string, { q: [number, string][] } | undefined>)[RL_SLOT]?.q ?? []).map(([, l]) => l);

  it('记状态迁移、错误码和 left、STALE、续期、取图失败；不记标题、正文、密码、令牌、图片 id', async () => {
    const IMGX = '44444444-4444-4444-8444-444444444444';
    const m = make({ unlock: () => ({ ok: false, code: 'pin_wrong', left: 3 }) });
    await m.s.refreshStatus();
    await m.s.unlock('8642');
    const { s, api } = await unlocked({ list: () => listOk([note({ title: '秘密标题', body: '秘密正文' })]) });
    const h = held();
    let renews = 0;
    const m3 = await unlocked({ renew: () => (++renews ? { ok: true, vault_token: TOK2, expires_at: 9e12 } : null), delete: () => h.p });
    m3.clock.ms += 6 * 60_000;
    m3.s.touch();
    await new Promise((r) => setTimeout(r, 0));
    const d = m3.s.remove(NID);
    m3.s.lock();
    h.release({ ok: true, vault_token: TOK2, expires_at: 9e12 });
    await d;
    (api.imageGet as unknown as { mockResolvedValueOnce(v: unknown): void }).mockResolvedValueOnce({ ok: false, code: 'try_later' });
    await s.image(IMGX, 'full');
    const all = lines().join('\n');
    expect(all).toMatch(/vault state locked/);
    expect(all).toMatch(/vault state unlocked/);
    expect(all).toMatch(/vault fail pin_wrong left=3/);
    expect(all).toMatch(/vault renew ok/);
    expect(all).toMatch(/vault stale hard ok/);
    expect(all).toMatch(/vault image full fail try_later/);
    for (const bad of ['秘密标题', '秘密正文', '8642', '1234', TOK, TOK2, IMGX]) expect(all).not.toContain(bad);
  });
});
