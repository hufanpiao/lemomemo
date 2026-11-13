// 隐私记会话（data/session.ts）：TC-B5-10（59 秒 / 61 秒，注入时间）、TC-B5-11（上锁不留明文、blob 撤销）、
// TC-B5-47 ①②（vault_locked 等解锁后自动重试一次；vault_relock 丢令牌、记 relocked）、TC-B5-33（断网）、图片半路上锁丢掉结果
import { describe, expect, it, vi } from 'vitest';
import { IMG, listOk, make, NID, statusSet, TOK, TOK2, tokenOk, unlocked } from './session-fakes.ts';

describe('解锁、上锁', () => {
  it('解锁后拉列表，明文只在内存；令牌抄给 core/vault-token', async () => {
    const { s, tokens } = await unlocked();
    expect(s.get().phase).toBe('unlocked');
    expect(s.get().notes?.[0]?.body).toBe('血压 120/80');
    expect(tokens.at(-1)).toBe(TOK);
    expect(s.hasToken()).toBe(true);
  });

  it('TC-B5-11：上锁清明文、清令牌、撤销全部 blob 地址；撤销后不再给旧地址', async () => {
    const { s, tokens, revoked } = await unlocked();
    const url = await s.image(IMG, 'thumb');
    expect(url).toBe('blob:x/1');
    expect(s.blobCount()).toBe(1);
    s.lock();
    expect(s.get()).toMatchObject({ phase: 'locked', notes: null });
    expect(s.hasToken()).toBe(false);
    expect(tokens.at(-1)).toBeNull();
    expect(revoked).toEqual(['blob:x/1']);
    expect(s.blobCount()).toBe(0);
    expect(await s.image(IMG, 'thumb')).toBeNull();
  });

  it('取图半路上锁：结果丢掉，不造新地址', async () => {
    const { s, api } = await unlocked();
    let release!: () => void;
    vi.mocked(api.imageGet).mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ ok: true, value: new Blob(['y']) }))),
    );
    const p = s.image(IMG, 'full');
    s.lock();
    release();
    expect(await p).toBeNull();
    expect(s.blobCount()).toBe(0);
  });

  it('输错：记下还能试几次；锁定：记下到什么时候', async () => {
    const m = make({ unlock: () => ({ ok: false, code: 'pin_wrong', left: 3 }) });
    await m.s.refreshStatus();
    await m.s.unlock('0000');
    expect(m.s.get()).toMatchObject({ phase: 'locked', left: 3, lastError: 'pin_wrong' });
    const m2 = make({ unlock: () => ({ ok: false, code: 'pin_locked', retryAfterS: 30 }) });
    await m2.s.refreshStatus();
    await m2.s.unlock('0000');
    expect(m2.s.get()).toMatchObject({ lockedUntil: 1_000_000 + 30_000, left: 0, lastError: 'pin_locked' });
  });
});

describe('TC-B5-10：离开满时长才上锁（注入时间）', () => {
  it('1 分钟：59 秒回来仍解锁，61 秒回来已上锁', async () => {
    const { s } = await unlocked();
    s.hide(0);
    expect(s.show(59_000, 1)).toBe(false);
    expect(s.get().phase).toBe('unlocked');
    s.hide(100_000);
    expect(s.show(161_000, 1)).toBe(true);
    expect(s.get()).toMatchObject({ phase: 'locked', notes: null });
  });

  it('改时长生效：5 分钟时 4 分 59 秒不锁、5 分 1 秒锁', async () => {
    const { s } = await unlocked();
    s.hide(0);
    expect(s.show(299_000, 5)).toBe(false);
    s.hide(0);
    expect(s.show(301_000, 5)).toBe(true);
  });

  it('锁着时离开、回来什么也不动', async () => {
    const m = make();
    await m.s.refreshStatus();
    m.s.hide(0);
    expect(m.s.show(999_000, 1)).toBe(false);
    expect(m.s.get().phase).toBe('locked');
  });
});

describe('TC-B5-47：错误码怎么落', () => {
  it('① vault_locked：上锁、弹解锁（waiting）；解锁成功后原请求自动重试一次，第二次带新令牌', async () => {
    let n = 0;
    const { s, calls } = await unlocked({
      delete: () => (++n === 1 ? { ok: false, code: 'vault_locked' } : { ok: true, vault_token: TOK2, expires_at: 9e12 }),
    });
    const p = s.remove(NID);
    await vi.waitFor(() => expect(s.get().waiting).toBe(true));
    expect(s.get()).toMatchObject({ phase: 'locked', notes: null });
    await s.unlock('1234');
    const r = await p;
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.action === 'delete')).toHaveLength(2);
    expect(s.get().waiting).toBe(false);
  });

  it('① 重试还是 vault_locked：停下（只重试一次），保持锁着', async () => {
    const { s, calls } = await unlocked({ delete: () => ({ ok: false, code: 'vault_locked' }) });
    const p = s.remove(NID);
    await vi.waitFor(() => expect(s.get().waiting).toBe(true));
    await s.unlock('1234');
    const r = await p;
    expect(r).toMatchObject({ ok: false, code: 'vault_locked' });
    expect(calls.filter((c) => c.action === 'delete')).toHaveLength(2);
    expect(s.get().phase).toBe('locked');
  });

  it('① 取消解锁：原请求回失败，不再发', async () => {
    const { s, calls } = await unlocked({ delete: () => ({ ok: false, code: 'vault_locked' }) });
    const p = s.remove(NID);
    await vi.waitFor(() => expect(s.get().waiting).toBe(true));
    s.cancelWait();
    expect((await p).ok).toBe(false);
    expect(calls.filter((c) => c.action === 'delete')).toHaveLength(1);
  });

  it('② vault_relock：丢令牌、清明文、relocked = true（不显示 Face ID）；用新密码解锁后 relocked 复位', async () => {
    const { s } = await unlocked({ save: () => ({ ok: false, code: 'vault_relock' }) });
    const r = await s.save({ id: NID, title: 'a', body: 'b' });
    expect(r).toMatchObject({ ok: false, code: 'vault_relock' });
    expect(s.get()).toMatchObject({ phase: 'locked', notes: null, relocked: true });
    expect(s.hasToken()).toBe(false);
    await s.unlock('5678');
    expect(s.get().relocked).toBe(false);
  });

  it('session_revoked：上锁（退出交给同步引擎）', async () => {
    let n = 0;
    const { s } = await unlocked({ list: () => (++n === 1 ? listOk() : { ok: false, code: 'session_revoked' }) });
    await s.list();
    expect(s.get()).toMatchObject({ phase: 'locked', notes: null, lastError: 'session_revoked' });
  });

  it('⑥ try_later：只记码，不上锁', async () => {
    const { s } = await unlocked({ delete: () => ({ ok: false, code: 'try_later' }) });
    await s.remove(NID);
    expect(s.get()).toMatchObject({ phase: 'unlocked', lastError: 'try_later' });
  });
});

describe('TC-B5-33：断网', () => {
  it('锁着时断网：进不去（phase = offline），没有明文；联网后能正常解锁', async () => {
    let online = false;
    const m = make({ status: () => (online ? statusSet : { ok: false, code: 'offline' }) });
    await m.s.refreshStatus();
    expect(m.s.get()).toMatchObject({ phase: 'offline', notes: null });
    online = true;
    await m.s.refreshStatus();
    expect(m.s.get().phase).toBe('locked');
    expect((await m.s.unlock('1234')).ok).toBe(true);
    expect(m.s.get().phase).toBe('unlocked');
  });
});

describe('保存、移进隐私记', () => {
  const NEW = '33333333-3333-4333-8333-333333333333';
  const IMG_NEW = '44444444-4444-4444-8444-444444444444';
  const pic = { id: IMG_NEW, full: new Blob(['f']), thumb: new Blob(['t']), width: 10, height: 20 };

  it('M1 新建带图：先存一次文字把这条建出来，再传 full、thumb，再 save 带 add_images；成功后重新拉列表', async () => {
    const { s, api, calls } = await unlocked();
    const r = await s.save({ id: null, title: 't', body: 'b', addImages: [pic] });
    expect(r).toEqual({ ok: true, value: NEW });
    expect(vi.mocked(api.imageUpload).mock.calls.map((c) => [c[0].note_id, c[0].image_id, c[0].part])).toEqual([[NEW, IMG_NEW, 'full'], [NEW, IMG_NEW, 'thumb']]);
    const order = calls.map((c) => c.action);
    expect(order.slice(order.indexOf('save'))).toEqual(['save', 'save', 'list']);
    const saves = calls.flatMap((c) => (c.req.action === 'save' ? [c.req] : []));
    expect(saves.map((x) => x.add_images?.map((i) => i.id) ?? null)).toEqual([null, [IMG_NEW]]);
  });

  it('改已有的一条带图：不先存文字，直接传图再保存', async () => {
    const { s, calls } = await unlocked();
    expect((await s.save({ id: NID, title: 't', body: 'b', addImages: [pic] })).ok).toBe(true);
    expect(calls.filter((c) => c.action === 'save')).toHaveLength(1);
  });

  it('传图失败后重试：同一个图片 id、同一条隐私记（不另生成），第二次成功', async () => {
    const { s, api } = await unlocked();
    vi.mocked(api.imageUpload).mockResolvedValueOnce({ ok: false, code: 'try_later' });
    const id = '55555555-5555-4555-8555-555555555555';
    const input = { id, title: 't', body: 'b', addImages: [pic] };
    expect(await s.save(input)).toMatchObject({ ok: false, code: 'try_later' });
    expect((await s.save(input)).ok).toBe(true);
    const keys = vi.mocked(api.imageUpload).mock.calls.map((c) => `${c[0].note_id}/${c[0].image_id}`);
    expect(new Set(keys)).toEqual(new Set([`${id}/${IMG_NEW}`]));
  });

  it('传图时令牌过期（vault_locked）：先发 renew（不是 list_credentials）换新令牌再传', async () => {
    const { s, api, calls } = await unlocked({ renew: () => ({ ok: true, vault_token: TOK2, expires_at: 9e12 }) });
    vi.mocked(api.imageUpload).mockResolvedValueOnce({ ok: false, code: 'vault_locked' });
    expect((await s.save({ id: NID, title: 't', body: 'b', addImages: [pic] })).ok).toBe(true);
    expect(calls.map((c) => c.action)).toContain('renew');
    expect(calls.map((c) => c.action)).not.toContain('list_credentials');
    expect(vi.mocked(api.imageUpload).mock.calls[1]?.[2]).toBe(TOK2);
  });

  it('importNote：锁着时也是走 run（vault_locked 会等解锁）；成功后已解锁才重新拉列表', async () => {
    const m = make({ import: () => tokenOk });
    await m.s.refreshStatus();
    expect((await m.s.importNote(NID)).ok).toBe(true);
    expect(m.calls.map((c) => c.action)).toEqual(['status', 'import']);
  });
});
