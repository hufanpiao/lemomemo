// 隐私记会话（data/session.ts）11-14 整块评审：第 8 条两种上锁、第 6 条 pin_wrong 带倒计时、第 14 条运行日志不带敏感内容
import { afterEach, describe, expect, it } from 'vitest';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import { noteRowOf } from '../data/vault-store.ts';
import { held, listOk, make, NID, note, TOK, TOK2, tokenOk, unlocked } from './session-fakes.ts';

const locked = { ok: false, code: 'vault_locked' };
/** 拿来触发令牌过期上锁的另一条（永久删除会先撤掉被删那几条的队列任务，H5） */
const OTHER = '33333333-3333-4333-8333-333333333333';

describe('M1：上锁只有一套做法（上锁以后回来的一律当失败；令牌过期时队列暂停、解锁后整条重发）', () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const row = () => ({ ...noteRowOf(note()), body: '队列里的' });

  it('队列的保存在路上时令牌过期上锁、保存回来成功：也当失败（锁着不收令牌），解锁后整条重发一次', async () => {
    const h = held();
    let saves = 0;
    const { s, calls } = await unlocked({ save: () => (++saves === 1 ? h.p : { ok: true, vault_token: TOK2, expires_at: 9e12 }), purge: () => locked });
    s.queue.wrote(row(), false);
    await settle();
    await s.purge([OTHER]);
    expect(s.get()).toMatchObject({ phase: 'locked', waiting: true });
    h.release({ ok: true, vault_token: TOK2, expires_at: 9e12 });
    await settle();
    expect(s.hasToken()).toBe(false);
    expect(s.queue.size()).toBe(1);
    expect((await s.unlock('1234')).ok).toBe(true);
    await settle();
    expect(calls.filter((c) => c.action === 'save')).toHaveLength(2);
    expect(s.queue.size()).toBe(0);
  });

  it('锁着（等解锁）时补交的改动只记字段：解锁拉完列表合并成整行再发', async () => {
    const { s, calls } = await unlocked({ purge: () => locked });
    await s.purge([NID]);
    s.queue.patched(NID, { body: '锁着时补交的' });
    await settle();
    expect(calls.filter((c) => c.action === 'save')).toHaveLength(0);
    expect((await s.unlock('1234')).ok).toBe(true);
    await settle();
    const sent = calls.filter((c) => c.action === 'save');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.req).toMatchObject({ title: '体检报告', body: '锁着时补交的' });
    expect(s.store.get(NID)?.['body']).toBe('锁着时补交的');
  });

  it('读请求（list）在路上时令牌过期上锁：回来的明文照样丢', async () => {
    const h = held();
    let n = 0;
    const { s } = await unlocked({ list: () => (++n === 1 ? listOk() : h.p), purge: () => locked });
    const p = s.list();
    await s.purge([NID]);
    h.release(listOk([note({ title: '新的' })]));
    expect((await p).ok).toBe(false);
    expect(s.store.getSnapshot().notes).toEqual([]);
  });

  it('用户主动上锁：在飞的保存回来不算、队列丢掉记个数，解锁后不重发', async () => {
    const h = held();
    const { s, calls } = await unlocked({ save: () => h.p });
    s.queue.wrote(row(), false);
    await settle();
    s.lock();
    h.release({ ok: true, vault_token: TOK2, expires_at: 9e12 });
    await settle();
    expect(s.hasToken()).toBe(false);
    expect(s.store.getSnapshot().dropped).toBe(1);
    expect((await s.unlock('1234')).ok).toBe(true);
    await settle();
    expect(calls.filter((c) => c.action === 'save')).toHaveLength(1);
  });

  it('H1：令牌过期等解锁时离开计时不清、照常走，满时长硬上锁丢队列', async () => {
    const h = held();
    const { s, clock } = await unlocked({ purge: () => locked, save: () => h.p });
    s.hide(clock.ms, 'app');
    s.queue.wrote(row(), false);
    await s.purge([OTHER]);
    expect(s.get().waiting).toBe(true);
    expect(s.check(clock.ms + 61_000, 1)).toBe(true);
    expect(s.get()).toMatchObject({ phase: 'locked', waiting: false });
    expect(s.queue.size()).toBe(0);
    expect(s.store.getSnapshot().dropped).toBe(1);
  });
});

describe('H5：永久删除、移出隐私记时队列里这一条不再 save 回来', () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const ok = { ok: true, vault_token: TOK2, expires_at: 9e12 };

  it('改完马上永久删除：在路上的保存回来失败也不标“没保存上”、不再发；purge 发出去', async () => {
    const h = held();
    const { s, calls } = await unlocked({ save: () => h.p, purge: () => ({ ...ok, purged: 1 }) });
    s.queue.wrote({ ...noteRowOf(note()), body: '刚改的' }, false);
    await settle();
    const p = s.purge([NID]);
    expect(s.queue.size()).toBe(0);
    h.release({ ok: false, code: 'not_found' });
    await p;
    await settle();
    expect(calls.filter((c) => c.action === 'save')).toHaveLength(1);
    expect(calls.filter((c) => c.action === 'purge')).toHaveLength(1);
    expect(s.store.getSnapshot().failed.has(NID)).toBe(false);
  });

  it('移出在路上时又改了：这一条不发；移出成了整条丢掉，不在隐私记里重建', async () => {
    const h = held();
    const { s, calls } = await unlocked({ export: () => h.p });
    const p = s.exportNote(NID);
    await settle();
    s.queue.wrote({ ...noteRowOf(note()), body: '移出时又改的' }, false);
    await settle();
    expect(calls.filter((c) => c.action === 'save')).toHaveLength(0);
    h.release(ok);
    expect((await p).ok).toBe(true);
    await settle();
    expect(calls.filter((c) => c.action === 'save')).toHaveLength(0);
    expect(s.queue.size()).toBe(0);
    expect(s.store.get(NID)).toBeUndefined();
  });

  it('移出失败：放开这一条，又改的照常发', async () => {
    const { s, calls } = await unlocked({ export: () => ({ ok: false, code: 'not_found' }) });
    const p = s.exportNote(NID);
    s.queue.wrote({ ...noteRowOf(note()), body: '移出时又改的' }, false);
    expect((await p).ok).toBe(false);
    await settle();
    expect(calls.filter((c) => c.action === 'save')).toHaveLength(1);
  });
});

describe('第 22 条配合：续期被拒（超过 12 小时、或闲置过期）时没发完的改动不丢', () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('打字触发续期回 vault_locked → 等解锁；队列里的改动解锁后发一次，拉完列表本机这一份盖回仓库', async () => {
    let renews = 0;
    const { s, calls, clock } = await unlocked({ renew: () => (++renews === 1 ? locked : tokenOk), save: (_r, tok) => (tok ? { ok: true, vault_token: TOK2, expires_at: 9e12 } : locked) });
    // 人在隐私记页上（不在页上的话等解锁时离开计时照走，6 分钟早就硬上锁了，H1）
    s.show(clock.ms, 1, 'page');
    clock.ms += 6 * 60_000;
    s.touch();
    await settle();
    expect(s.get()).toMatchObject({ phase: 'locked', waiting: true, listed: false });
    s.queue.wrote({ ...noteRowOf(note()), title: '草稿', body: '还没存' }, false);
    await settle();
    expect((await s.unlock('1234')).ok).toBe(true);
    await settle();
    const sent = calls.filter((c) => c.action === 'save' && c.token !== null);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.req).toMatchObject({ title: '草稿', body: '还没存' });
    expect(s.store.get(NID)?.['body']).toBe('还没存');
    expect(s.queue.size()).toBe(0);
  });

  it('等解锁时用户主动上锁：队列丢掉、记下个数，不发保存', async () => {
    const { s, calls, clock } = await unlocked({ renew: () => locked, save: (_r, tok) => (tok ? tokenOk : locked) });
    clock.ms += 6 * 60_000;
    s.touch();
    await settle();
    s.queue.wrote({ ...noteRowOf(note()), body: 'x' }, false);
    await settle();
    s.lock();
    expect(s.store.getSnapshot().dropped).toBe(1);
    expect((await s.unlock('1234')).ok).toBe(true);
    await settle();
    expect(calls.filter((c) => c.action === 'save' && c.token !== null)).toHaveLength(0);
    expect(s.store.getSnapshot().dropped).toBe(1);
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
    expect(all).toMatch(/vault stale ok/);
    expect(all).toMatch(/vault image full wait try_later/);
    for (const bad of ['秘密标题', '秘密正文', '8642', '1234', TOK, TOK2, IMGX]) expect(all).not.toContain(bad);
  });
});
