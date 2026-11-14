// 隐私记会话（data/session.ts）独立评审修复：S1 请求在路上时上锁整个丢掉、M6 取图失败不缓存 + 令牌过期先续期、M2 编辑时续期、M3 改密码
import { describe, expect, it, vi } from 'vitest';
import { RENEW_AFTER_MS } from '../data/session.ts';
import { held, IMG, listOk, make, NID, statusSet, TOK2, tokenOk, unlocked } from './session-fakes.ts';

describe('S1：请求在路上时上锁，回来的结果整个丢掉', () => {
  it('list 在路上时 Ctrl+L：回来后不收令牌、不写明文', async () => {
    const h = held();
    let n = 0;
    const { s } = await unlocked({ list: () => (++n === 1 ? listOk() : h.p) });
    const p = s.list();
    s.lock();
    h.release(listOk());
    expect((await p).ok).toBe(false);
    expect(s.hasToken()).toBe(false);
    expect(s.get()).toMatchObject({ phase: 'locked', notes: null, waiting: false });
  });

  it('普通请求（delete）在路上时离开满时长自动上锁：回来后不收令牌、不弹解锁、不重试', async () => {
    const h = held();
    const { s, calls } = await unlocked({ delete: () => h.p });
    const p = s.remove(NID);
    s.hide(0);
    expect(s.show(61_000, 1)).toBe(true);
    h.release({ ok: true, vault_token: TOK2, expires_at: 9e12 });
    expect((await p).ok).toBe(false);
    expect(s.hasToken()).toBe(false);
    expect(s.get()).toMatchObject({ phase: 'locked', notes: null, waiting: false });
    expect(calls.filter((c) => c.action === 'delete')).toHaveLength(1);
  });

  it('解锁请求在路上时上锁：签来的令牌丢掉，不进已解锁、不拉列表', async () => {
    const h = held();
    const m = make({ unlock: () => h.p });
    await m.s.refreshStatus();
    const p = m.s.unlock('1234');
    m.s.lock();
    h.release(tokenOk);
    expect((await p).ok).toBe(false);
    expect(m.s.hasToken()).toBe(false);
    expect(m.s.get().phase).toBe('locked');
    expect(m.calls.map((c) => c.action)).not.toContain('list');
  });
});

describe('审查第 2 条：等解锁（waiting）时离开满时长也作废', () => {
  it('令牌过期、草稿交给 saveWhenUnlocked 后离开 61 秒回来：草稿丢掉、waiting 落回；之后解锁不保存', async () => {
    const { s, calls } = await unlocked({ delete: () => ({ ok: false, code: 'vault_locked' }) });
    const r = s.remove(NID);
    await vi.waitFor(() => expect(s.get().waiting).toBe(true));
    const draft = s.saveWhenUnlocked({ id: NID, title: '草稿', body: '正文' });
    s.hide(0);
    expect(s.show(61_000, 1)).toBe(true);
    expect((await draft).ok).toBe(false);
    expect((await r).ok).toBe(false);
    expect(s.get()).toMatchObject({ phase: 'locked', waiting: false });
    await s.unlock('1234');
    expect(calls.filter((c) => c.action === 'save')).toHaveLength(0);
  });

  it('等解锁时离开 59 秒回来：什么也不动，还在等', async () => {
    const { s } = await unlocked({ delete: () => ({ ok: false, code: 'vault_locked' }) });
    void s.remove(NID);
    await vi.waitFor(() => expect(s.get().waiting).toBe(true));
    s.hide(0);
    expect(s.show(59_000, 1)).toBe(false);
    expect(s.get().waiting).toBe(true);
  });
});

describe('M6：取图失败不缓存；令牌过期先续期', () => {
  it('取图失败（服务忙）回 null，下次再取会重新请求、能拿到；界面状态不变', async () => {
    const { s, api } = await unlocked();
    vi.mocked(api.imageGet).mockResolvedValueOnce({ ok: false, code: 'try_later' });
    expect(await s.image(IMG, 'full')).toBeNull();
    expect(await s.image(IMG, 'full')).toBe('blob:x/1');
    expect(api.imageGet).toHaveBeenCalledTimes(2);
    expect(s.get()).toMatchObject({ phase: 'unlocked', lastError: null });
  });

  it('取图时 vault_locked：先 renew 换新令牌再取一次', async () => {
    const { s, api, calls } = await unlocked({ renew: () => ({ ok: true, vault_token: TOK2, expires_at: 9e12 }) });
    vi.mocked(api.imageGet).mockResolvedValueOnce({ ok: false, code: 'vault_locked' });
    expect(await s.image(IMG, 'thumb')).toBe('blob:x/1');
    expect(calls.map((c) => c.action)).toContain('renew');
    expect(vi.mocked(api.imageGet).mock.calls[1]?.[2]).toBe(TOK2);
  });

  it('取图时密码已在别处改（vault_relock）：上锁、relocked', async () => {
    const { s, api } = await unlocked();
    vi.mocked(api.imageGet).mockResolvedValueOnce({ ok: false, code: 'vault_relock' });
    expect(await s.image(IMG, 'thumb')).toBeNull();
    expect(s.get()).toMatchObject({ phase: 'locked', relocked: true });
  });
});

describe('M2：编辑时续期（touch）', () => {
  it('拿到令牌不满 5 分钟不续；满 5 分钟有输入就续一次，正在续、刚续过都不重复发', async () => {
    const { s, calls, clock } = await unlocked();
    const renews = () => calls.filter((c) => c.action === 'renew').length;
    clock.ms += RENEW_AFTER_MS - 1;
    s.touch();
    expect(renews()).toBe(0);
    clock.ms += 1;
    s.touch();
    s.touch();
    expect(renews()).toBe(1);
    await vi.waitFor(() => expect(s.hasToken()).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    s.touch();
    expect(renews()).toBe(1);
  });

  it('锁着时 touch 什么也不做', async () => {
    const { s, calls, clock } = await unlocked();
    s.lock();
    clock.ms += RENEW_AFTER_MS * 2;
    s.touch();
    expect(calls.filter((c) => c.action === 'renew')).toHaveLength(0);
  });
});

describe('M3：改密码', () => {
  it('成功后服务器已删全部凭据：status.webauthn 同步成 0', async () => {
    const { s } = await unlocked({ status: () => ({ ...statusSet, webauthn: 2 }), change_pin: () => tokenOk });
    expect(s.get().status?.webauthn).toBe(2);
    expect((await s.changePin('1234', '5678')).ok).toBe(true);
    expect(s.get().status?.webauthn).toBe(0);
  });

  it('旧密码输错：响应带 left，会话也记下；不上锁', async () => {
    const { s } = await unlocked({ change_pin: () => ({ ok: false, code: 'pin_wrong', left: 2 }) });
    expect(await s.changePin('0000', '5678')).toMatchObject({ ok: false, code: 'pin_wrong', left: 2 });
    expect(s.get()).toMatchObject({ left: 2, lastError: 'pin_wrong', phase: 'unlocked' });
  });
});
