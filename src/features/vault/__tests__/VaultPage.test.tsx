// 隐私记页面（ui/VaultPage.tsx）：TC-B5-11（上锁后 DOM 里不留明文）、TC-B5-12（挂着时 <html data-rt="1">，卸掉还原；GlassBar 不碰隐私记）、
// TC-B5-13（解锁卡淡出 --dur-ui，上锁、多任务遮罩直接盖）、TC-B5-44（三个离开事件同步盖遮罩，59 秒回来去掉、61 秒上锁）、
// TC-B5-33（断网进不去）、TC-B5-48 ②（解锁后看得到自己的“最近删除”，永久删除要确认）
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultRequest } from '../../../../shared/schema/vault.ts';
import { createVaultSession, type VaultSession } from '../data/session.ts';
import { installVaultSession, SHIELD_ATTR, watchLeave } from '../hooks/useVault.ts';
import VaultPage from '../ui/VaultPage.tsx';
import VaultParts from '../ui/VaultParts.tsx';
import { applyLook } from '../../../platform/look.ts';
import { useKeys } from '../../../kit/hooks/layers.ts';
import type * as Enc from '../../../platform/image-encode.ts';
import { fakeApi, make, NID, note, TOK } from './session-fakes.ts';

vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: () => [] }));
// 插图：jsdom 没有画布，压图换成桩（压成了一张 10×6 的图）
vi.mock('../../../platform/image-encode.ts', async (orig) => ({
  ...(await orig<typeof Enc>()),
  encodeImage: async () => ({ ok: true, full: new Blob(['full']), thumb: new Blob(['t']), width: 10, height: 6, takenAt: null }),
}));

const GONE = '22222222-2222-4222-8222-222222222222';
const SECRET = note().body;

function session(o: { offline?: boolean; purge?: () => void; exportFail?: boolean } = {}): VaultSession {
  const reply = (req: VaultRequest): unknown => {
    switch (req.action) {
      case 'status':
        return o.offline ? { ok: false, code: 'offline' } : { ok: true, set: true, locked_until: null, retry_after_s: null, last_reset_at: null, webauthn: 0 };
      case 'list':
        return { ok: true, notes: [note(), note({ id: GONE, title: '旧的', body: '删掉的', deleted_at: 5 })], vault_token: TOK, expires_at: 9e12 };
      case 'purge':
        o.purge?.();
        return { ok: true, purged: 1, vault_token: TOK, expires_at: 9e12 };
      case 'export':
        return o.exportFail ? { ok: false, code: 'unknown' } : { ok: true, vault_token: TOK, expires_at: 9e12 };
      default:
        return { ok: true, vault_token: TOK, expires_at: 9e12 };
    }
  };
  // 每个动作都走 reply（假 api 是会话测试那一份；时间、睡眠用真的，计时用例靠假计时器）
  const { api } = fakeApi({}, reply);
  return createVaultSession({ api, onToken: () => undefined, createUrl: () => 'blob:x', revokeUrl: () => undefined });
}

let s: VaultSession;
beforeEach(() => {
  window.location.hash = '#/vault';
  document.documentElement.removeAttribute('data-rt');
  document.documentElement.removeAttribute(SHIELD_ATTR);
});
afterEach(() => {
  cleanup();
  installVaultSession(null);
  window.location.hash = '';
});

async function openUnlocked(o: Parameters<typeof session>[0] = {}) {
  s = session(o);
  installVaultSession(s);
  render(<VaultPage />);
  await screen.findByTestId('vault-unlock-card');
  await act(async () => {
    await s.unlock('1234');
  });
  await screen.findByTestId('vault-notes');
}

describe('解锁、上锁', () => {
  it('线框 s9：用不了 Face ID 时解锁卡只有“输入密码”“取消”；点了进整页密码页，顶栏“‹ 随手记 … 取消”，提示在圆点下、键盘上；手机宽度不出快捷键提示', async () => {
    s = session();
    installVaultSession(s);
    render(<VaultPage />);
    const card = await screen.findByTestId('vault-unlock-card');
    expect(screen.queryByTestId('vault-unlock-face')).toBeNull();
    // 负责人 11-19“锁着用甲”：锁屏居中，顶栏“‹ 随手记”（DOM 里排第一）代替原来的“取消”，打开时焦点仍落在主按钮“输入密码”上
    expect([...card.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['‹ 随手记', '输入密码']);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('vault-unlock-pin')));
    expect(screen.queryByTestId('vault-unlock-pinview')).toBeNull();
    fireEvent.click(screen.getByTestId('vault-unlock-pin'));
    const view = await screen.findByTestId('vault-unlock-pinview');
    expect(screen.getByTestId('vault-unlock-back').textContent).toContain('随手记');
    expect(screen.getByTestId('vault-unlock-cancel').textContent).toBe('取消');
    const pad = screen.getByTestId('vault-unlock-pad');
    const order = [...pad.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'));
    expect(order.indexOf('vault-unlock-pad-dots')).toBeLessThan(order.indexOf('vault-unlock-err'));
    expect(order.indexOf('vault-unlock-err')).toBeLessThan(order.indexOf('vault-unlock-pad-key-0'));
    expect(view.textContent).not.toContain('Ctrl + L');
  });

  it('锁着：只有解锁卡，没有内容；解锁后列出；TC-B5-11 上锁后 DOM 里不留明文', async () => {
    await openUnlocked();
    // B5 隐私记重写：列表跟随手记一样（标题、摘要）；删了的那条不在列表里
    expect(screen.getByTestId('vault-notes').textContent).toContain('体检报告');
    expect(screen.getByTestId('vault-notes').textContent).not.toContain('删掉的');
    act(() => s.lock());
    await screen.findByTestId('vault-unlock-card');
    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain('体检报告');
    expect(screen.queryByTestId('vault-notes')).toBeNull();
  });

  it('负责人 11-19“解锁后用乙”：#/vault 是首页（最新几条、“全部 N ›”）；点“全部”进 #/vault/c/all 的列表，顶上“‹ 隐私记”回首页', async () => {
    await openUnlocked();
    const home = await screen.findByTestId('vault-home');
    expect(home.textContent).toContain('体检报告');
    expect(screen.queryByTestId(`notes-more-${NID}`)).toBeNull();
    for (const tile of home.querySelectorAll('[data-testid^="vault-home-cat-"]')) expect(tile.textContent).toMatch(/\d/);
    fireEvent.click(screen.getByTestId('vault-home-all'));
    await waitFor(() => expect(window.location.hash).toBe('#/vault/c/all'));
    expect(await screen.findByTestId(`notes-more-${NID}`)).toBeTruthy();
    expect(screen.queryByTestId('vault-home')).toBeNull();
    fireEvent.click(screen.getByTestId('vault-back-home'));
    await waitFor(() => expect(window.location.hash).toBe('#/vault'));
    expect(await screen.findByTestId('vault-home')).toBeTruthy();
  });

  it('独立评审 11-19 中 2：地址就是筛选——#/vault/c/<已经没了的分类> 解锁后原地换成 #/vault/c/all，列表是全部', async () => {
    window.location.hash = '#/vault/c/gone-cat';
    await openUnlocked();
    await waitFor(() => expect(window.location.hash).toBe('#/vault/c/all'));
    expect(await screen.findByTestId(`notes-more-${NID}`)).toBeTruthy();
    expect(screen.getByTestId('vault-back-home')).toBeTruthy();
  });

  it('随手记那一份“⋯”：移出隐私记走 exportNote；删除立刻从列表拿掉、进隐私记自己的最近删除（后台发 delete）', async () => {
    // 解锁后的首页是宫格（负责人 11-19“解锁后用乙”），列表在 #/vault/c/<分类>
    window.location.hash = '#/vault/c/all';
    await openUnlocked();
    const out = vi.spyOn(s, 'exportNote').mockResolvedValue({ ok: true, value: { ok: true, vault_token: 't', expires_at: 0 } });
    fireEvent.click(screen.getByTestId(`notes-more-${NID}`));
    expect(screen.queryByTestId(`notes-to-vault-${NID}`)).toBeNull();
    await act(async () => {
      fireEvent.click(await screen.findByTestId(`notes-from-vault-${NID}`));
    });
    expect(out).toHaveBeenCalledWith(NID);
    fireEvent.click(screen.getByTestId(`notes-more-${NID}`));
    await act(async () => {
      fireEvent.click(await screen.findByTestId(`notes-del-${NID}`));
    });
    expect(s.store.get(NID)?.['deleted_at']).not.toBeNull();
    await waitFor(() => expect(screen.getByTestId('vault-open-trash').getAttribute('aria-label')).toBe('最近删除 2'));
  });

  it('Ctrl+L 立即上锁', async () => {
    await openUnlocked();
    act(() => {
      fireEvent.keyDown(window, { key: 'l', ctrlKey: true });
    });
    expect(s.get().phase).toBe('locked');
  });

  it('TC-B5-13：解锁成功时遮罩加淡出类（--dur-ui），过后卸掉；上锁时遮罩直接出现、没有淡出类', async () => {
    s = session();
    installVaultSession(s);
    render(<VaultPage />);
    const scrim = await screen.findByTestId('vault-scrim');
    expect(scrim.hasAttribute('data-leaving')).toBe(false);
    await act(async () => {
      await s.unlock('1234');
    });
    expect(screen.getByTestId('vault-scrim').getAttribute('data-leaving')).toBe('true');
    await waitFor(() => expect(screen.queryByTestId('vault-scrim')).toBeNull(), { timeout: 2000 });
    act(() => s.lock());
    expect(screen.getByTestId('vault-scrim').hasAttribute('data-leaving')).toBe(false);
    const css = readFileSync(join(import.meta.dirname, '../ui/Vault.module.css'), 'utf8');
    expect(css).toMatch(/\.scrim \{[^}]*transition: opacity var\(--dur-ui\)/);
    expect(css).not.toMatch(/\.shield \{[^}]*transition/);
    expect(css).not.toMatch(/@keyframes/);
  });
});

describe('TC-B5-12：底栏实色、不建副本', () => {
  it('页面挂着时 <html data-rt="1">，中途皮肤重画也不被冲掉；卸掉后按系统设置重算（系统没设置就拿掉）', async () => {
    s = session();
    installVaultSession(s);
    const base = { skin: 'glass', theme: 'light', font: 'system' } as const;
    applyLook(base);
    expect(document.documentElement.hasAttribute('data-rt')).toBe(false);
    const r = render(<VaultPage />);
    expect(document.documentElement.getAttribute('data-rt')).toBe('1');
    applyLook({ ...base, theme: 'dark' });
    expect(document.documentElement.getAttribute('data-rt')).toBe('1');
    r.unmount();
    expect(document.documentElement.hasAttribute('data-rt')).toBe(false);
  });

  it('GlassBar 不 import 隐私记、不持有隐私记数据', () => {
    const dir = join(import.meta.dirname, '../../../kit/components/GlassBar');
    for (const f of readdirSync(dir).filter((n) => /\.(ts|tsx)$/.test(n))) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/vault/i);
  });
});

describe('TC-B5-44：离开时同步盖多任务遮罩', () => {
  it.each(['visibilitychange', 'pagehide', 'blur'] as const)('%s 一到就同步盖上（不等渲染）', async (ev) => {
    await openUnlocked();
    const stop = watchLeave(s, window, () => 0);
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    if (ev === 'visibilitychange') document.dispatchEvent(new Event('visibilitychange'));
    else window.dispatchEvent(new Event(ev));
    expect(document.documentElement.getAttribute(SHIELD_ATTR)).toBe('1');
    expect(screen.getByTestId('vault-shield')).toBeTruthy();
    vis.mockRestore();
    stop();
  });

  it('59 秒回来：遮罩去掉、仍解锁；61 秒回来：上锁、露出解锁卡', async () => {
    await openUnlocked();
    let now = 0;
    const stop = watchLeave(s, window, () => now);
    window.dispatchEvent(new Event('blur'));
    now = 59_000;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(document.documentElement.hasAttribute(SHIELD_ATTR)).toBe(false);
    expect(s.get().phase).toBe('unlocked');
    now = 100_000;
    window.dispatchEvent(new Event('blur'));
    now = 161_000;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(document.documentElement.hasAttribute(SHIELD_ATTR)).toBe(false);
    expect(s.get().phase).toBe('locked');
    await screen.findByTestId('vault-unlock-card');
    expect(document.body.textContent).not.toContain(SECRET);
    stop();
  });
});

describe('TC-B5-33：断网', () => {
  it('锁着时断网：显示“要联网”和重试，没有密码键盘、没有内容', async () => {
    s = session({ offline: true });
    installVaultSession(s);
    render(<VaultPage />);
    await screen.findByTestId('vault-offline');
    expect(screen.queryByTestId('vault-unlock-card')).toBeNull();
    expect(screen.getByTestId('vault-retry')).toBeTruthy();
  });
});

describe('TC-B5-48 ②：隐私记自己的“最近删除”', () => {
  it('解锁后列出已删的；永久删除先确认，确认后才调 purge', async () => {
    const purge = vi.fn();
    s = session({ purge });
    installVaultSession(s);
    window.location.hash = '#/vault/trash';
    render(<VaultPage />);
    await screen.findByTestId('vault-unlock-card');
    await act(async () => {
      await s.unlock('1234');
    });
    await screen.findByTestId(`vault-trash-row-${GONE}`);
    expect(screen.queryByTestId(`vault-trash-row-${NID}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`vault-purge-${GONE}`));
    expect(purge).not.toHaveBeenCalled();
    await screen.findByTestId('vault-purge-confirm-ok');
    await act(async () => {
      fireEvent.click(screen.getByTestId('vault-purge-confirm-ok'));
    });
    await waitFor(() => expect(purge).toHaveBeenCalledTimes(1));
  });
});

/** 编辑页输入一段字、离开输入框（停笔提交，同随手记编辑页） */
async function type(testId: 'note-edit-title' | 'note-edit-body', value: string) {
  const el = await screen.findByTestId(testId);
  fireEvent.focus(el);
  fireEvent.change(el, { target: { value } });
  await act(async () => {
    fireEvent.blur(el);
    await new Promise((r) => setTimeout(r, 0));
  });
}
const saves = (m: ReturnType<typeof make>) => m.calls.filter((c) => c.action === 'save' && c.token !== null);

describe('11-14 整块评审第 22 条：令牌续不上（超过 12 小时、闲置过期）时编辑页没发完的改动不丢', () => {
  it('打字触发续期被拒 → 换成解锁卡、DOM 里没有草稿；解锁后改动发出去、编辑页还是本机那一份', async () => {
    let renews = 0;
    // 假服务器记住存上的正文（解锁后 list 回的是它）
    let body = SECRET;
    const m = make({
      renew: () => (++renews === 1 ? { ok: false, code: 'vault_locked' } : { ok: true, vault_token: TOK, expires_at: 9e12 }),
      save: (req, tok) => {
        if (!tok) return { ok: false, code: 'vault_locked' };
        if (req.action === 'save') body = req.body;
        return { ok: true, vault_token: TOK, expires_at: 9e12 };
      },
      list: () => ({ ok: true, notes: [note({ body })], vault_token: TOK, expires_at: 9e12 }),
    });
    installVaultSession(m.s);
    window.location.hash = `#/vault/${NID}`;
    render(<VaultPage />);
    await screen.findByTestId('vault-unlock-card');
    await act(async () => {
      await m.s.refreshStatus();
      await m.s.unlock('1234');
    });
    await screen.findByTestId('note-edit-body');
    m.clock.ms += 6 * 60_000;
    await type('note-edit-body', '还没存的正文');
    await screen.findByTestId('vault-unlock-card');
    expect(document.body.textContent).not.toContain('还没存的正文');
    await act(async () => {
      await m.s.unlock('1234');
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(saves(m).some((c) => c.req.action === 'save' && c.req.body === '还没存的正文')).toBe(true));
    expect((await screen.findByTestId('note-edit-body') as HTMLTextAreaElement).value).toBe('还没存的正文');
  });

  it('停笔 800ms 还没到就碰上令牌过期的上锁：编辑页卸下那一刻草稿交给队列，解锁后照常发；DOM 里不留草稿', async () => {
    let renews = 0;
    let body = SECRET;
    const m = make({
      renew: () => (++renews === 1 ? { ok: false, code: 'vault_locked' } : { ok: true, vault_token: TOK, expires_at: 9e12 }),
      save: (req, tok) => {
        if (!tok) return { ok: false, code: 'vault_locked' };
        if (req.action === 'save') body = req.body;
        return { ok: true, vault_token: TOK, expires_at: 9e12 };
      },
      list: () => ({ ok: true, notes: [note({ body })], vault_token: TOK, expires_at: 9e12 }),
    });
    installVaultSession(m.s);
    window.location.hash = `#/vault/${NID}`;
    render(<VaultPage />);
    await act(async () => {
      await m.s.refreshStatus();
      await m.s.unlock('1234');
    });
    const el = await screen.findByTestId('note-edit-body');
    // 只敲字、不失焦、不等停笔：草稿还在输入框里没交
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: '停笔前的字' } });
    m.clock.ms += 6 * 60_000;
    await act(async () => {
      m.s.touch();
      await new Promise((r) => setTimeout(r, 0));
    });
    await screen.findByTestId('vault-unlock-card');
    expect(document.body.textContent).not.toContain('停笔前的字');
    await act(async () => {
      await m.s.unlock('1234');
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(saves(m).some((c) => c.req.action === 'save' && c.req.body === '停笔前的字')).toBe(true));
    expect((await screen.findByTestId('note-edit-body') as HTMLTextAreaElement).value).toBe('停笔前的字');
  });

  it('主动上锁（作废在飞请求的上锁）时停笔还没到的字：不交、不发（安全优先，同上锁丢队列）', async () => {
    const m = make();
    installVaultSession(m.s);
    window.location.hash = `#/vault/${NID}`;
    render(<VaultPage />);
    await act(async () => {
      await m.s.refreshStatus();
      await m.s.unlock('1234');
    });
    const el = await screen.findByTestId('note-edit-body');
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: '锁前没停笔' } });
    await act(async () => {
      m.s.lock();
      await new Promise((r) => setTimeout(r, 0));
    });
    await screen.findByTestId('vault-unlock-card');
    await act(async () => {
      await m.s.unlock('1234');
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(m.calls.some((c) => c.action === 'save' && c.req.action === 'save' && c.req.body === '锁前没停笔')).toBe(false);
    expect(m.s.queue.size()).toBe(0);
  });
});

describe('B5 隐私记重写：停笔自动存、读写只碰内存仓库', () => {
  it('新建：停笔就进列表（不等服务器），后台发一次 save；没有“保存”按钮', async () => {
    const m = make();
    installVaultSession(m.s);
    window.location.hash = '#/vault/new';
    render(<VaultPage />);
    await act(async () => {
      await m.s.refreshStatus();
      await m.s.unlock('1234');
    });
    await type('note-edit-body', '新记的一条');
    expect(screen.queryByTestId('vault-edit-save')).toBeNull();
    expect(m.s.store.getSnapshot().notes.some((n) => n['body'] === '新记的一条')).toBe(true);
    await waitFor(() => expect(saves(m)).toHaveLength(1));
    expect(saves(m)[0]?.req).toMatchObject({ body: '新记的一条' });
  });

  it('保存碰上令牌过期 → 出解锁卡 → 解锁：只重发那一次，不多存', async () => {
    let n = 0;
    const m = make({ save: () => (++n === 1 ? { ok: false, code: 'vault_locked' } : { ok: true, vault_token: TOK, expires_at: 9e12 }) });
    installVaultSession(m.s);
    window.location.hash = '#/vault/new';
    render(<VaultPage />);
    await act(async () => {
      await m.s.refreshStatus();
      await m.s.unlock('1234');
    });
    await type('note-edit-body', '只存一次');
    await screen.findByTestId('vault-unlock-card');
    await act(async () => {
      await m.s.unlock('1234');
      await new Promise((r) => setTimeout(r, 10));
    });
    await waitFor(() => expect(m.calls.filter((c) => c.action === 'save')).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(m.calls.filter((c) => c.action === 'save')).toHaveLength(2);
  });

  it('审查第 1 条：令牌过期时解锁卡点“取消”：队列整个丢掉；再解锁不补发，列表出“有 1 处改动没来得及保存”', async () => {
    let n = 0;
    const m = make({ save: () => (++n === 1 ? { ok: false, code: 'vault_locked' } : { ok: true, vault_token: TOK, expires_at: 9e12 }) });
    installVaultSession(m.s);
    window.location.hash = '#/vault/new';
    render(<VaultPage />);
    await act(async () => {
      await m.s.refreshStatus();
      await m.s.unlock('1234');
    });
    await type('note-edit-body', '没存上的');
    await screen.findByTestId('vault-unlock-card');
    expect(m.s.get().waiting).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId('vault-unlock-cancel'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(m.s.get().waiting).toBe(false);
    expect(m.s.store.getSnapshot().dropped).toBe(1);
    window.location.hash = '#/vault';
    await act(async () => {
      await m.s.unlock('1234');
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(m.calls.filter((c) => c.action === 'save')).toHaveLength(1);
    expect((await screen.findByTestId('notes-sync-dropped')).textContent).toContain('1');
  });

  it('负责人“插图打不开”：编辑页插一张图 → 立刻显示本机那一份；传好了点它出看图页', async () => {
    const m = make();
    installVaultSession(m.s);
    window.location.hash = `#/vault/${NID}`;
    render(<VaultPage />);
    await act(async () => {
      await m.s.refreshStatus();
      await m.s.unlock('1234');
    });
    await screen.findByTestId('note-edit-body');
    await act(async () => {
      fireEvent.change(screen.getByTestId('note-edit-img-input'), { target: { files: [new File([new Uint8Array(5)], 'a.jpg', { type: 'image/jpeg' })] } });
      await new Promise((r) => setTimeout(r, 0));
    });
    const imgId = m.s.store.getSnapshot().images[0]?.id ?? '';
    expect(imgId).not.toBe('');
    await waitFor(() => expect(screen.getByTestId(`note-image-${imgId}`).getAttribute('data-state')).toBe('done'));
    expect(vi.mocked(m.api.imageUpload).mock.calls.map((c) => c[0].part)).toEqual(['full', 'thumb']);
    fireEvent.click(screen.getByTestId(`note-image-open-${imgId}`));
    expect(await screen.findByTestId(`img-view-pic-${imgId}`)).toBeTruthy();
    expect(m.api.imageGet).not.toHaveBeenCalled();
  });

  it('列表封面只取看得见的：没进视口的卡片不发 vault-image', async () => {
    const seen = new Set<Element>();
    const observers: { cb: IntersectionObserverCallback; els: Element[] }[] = [];
    class FakeIO {
      constructor(cb: IntersectionObserverCallback) {
        observers.push({ cb, els: [] });
      }
      observe(el: Element) {
        observers.at(-1)?.els.push(el);
        seen.add(el);
      }
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', FakeIO);
    const pic = { id: GONE, has_thumb: true, width: 10, height: 6, bytes: 3, deleted_at: null };
    const m = make({ list: () => ({ ok: true, notes: [note({ images: [pic] })], vault_token: TOK, expires_at: 9e12 }) });
    installVaultSession(m.s);
    window.location.hash = '#/vault/c/all';
    render(<VaultPage />);
    await act(async () => {
      await m.s.refreshStatus();
      await m.s.unlock('1234');
    });
    await screen.findByTestId('vault-notes');
    await new Promise((r) => setTimeout(r, 10));
    expect(m.api.imageGet).not.toHaveBeenCalled();
    expect(seen.size).toBeGreaterThan(0);
    await act(async () => {
      for (const o of observers) o.cb(o.els.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry), {} as IntersectionObserver);
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(m.api.imageGet).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });
});

describe('审查第 6 条：解锁遮罩是有名字的模态对话框，焦点移进去、圈在里面', () => {
  it('锁着：role=dialog 的名字是“隐私记已上锁”；焦点在遮罩里；遮罩外的内容对读屏隐藏', async () => {
    s = session();
    installVaultSession(s);
    render(<VaultPage />);
    await screen.findByTestId('vault-unlock-card');
    const dlg = await screen.findByRole('dialog', { name: '隐私记已上锁' });
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    await waitFor(() => expect(dlg.contains(document.activeElement)).toBe(true));
    // 锁着整屏居中（负责人 11-19“锁着用甲”）：页面顶栏不画，返回在遮罩里
    expect(screen.queryByTestId('vault-back')).toBeNull();
    expect(dlg.contains(screen.getByTestId('vault-unlock-cancel'))).toBe(true);
    // Esc 照旧是“取消”（Radix 接住后交给卡片的 cancel）：回随手记
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(window.location.hash).toBe('#/notes'));
  });
});

describe('层栈整块评审第 1 条：锁屏是模态层，页面快捷键收不到；数字键只给锁屏里的键盘', () => {
  it('锁着、输密码页：Ctrl+K 等页面的键不响应；数字键进锁屏的键盘；页面上另一个键盘收不到', async () => {
    const page = vi.fn();
    const behind = vi.fn();
    function PageKeys() {
      useKeys({ 'mod+k': () => (page(), true), '5': () => (behind(), true) });
      return null;
    }
    s = session();
    installVaultSession(s);
    render(
      <>
        <VaultPage />
        <PageKeys />
      </>,
    );
    fireEvent.click(await screen.findByTestId('vault-unlock-pin'));
    const dots = await screen.findByTestId('vault-unlock-pad-dots');
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(page).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: '5' });
    expect(behind).not.toHaveBeenCalled();
    expect(dots.getAttribute('data-n')).toBe('1');
    expect(document.documentElement.classList.contains('scroll-locked'), '锁屏不锁滚动（取消时直接换页，webkit View Transition 崩溃）').toBe(false);
  });
});

describe('随手记页的入口行（lockrow）不写条数（负责人 11-15：“不管解锁没解锁里面几条这个不用显示”）', () => {
  it('锁着写“已上锁”、解锁后写“已解锁”，都不带“N 条”', async () => {
    s = session();
    installVaultSession(s);
    render(<VaultParts part="lockrow" />);
    const row = await screen.findByTestId('vault-lockrow');
    await waitFor(() => expect(row.textContent).toContain('已上锁'));
    expect(row.textContent).not.toMatch(/\d+\s*条/);
    await act(async () => {
      await s.unlock('1234');
    });
    await waitFor(() => expect(row.textContent).toContain('已解锁'));
    expect(row.textContent).not.toMatch(/\d+\s*条/);
  });
});

describe('批 2 第 3 条：移出隐私记没成，提示是自己那一条（不借转换结果的 notes-conv-tip）', () => {
  it('export 被拒：输入行上面出“没移出去，稍后再试一次”，testid 是 notes-moveout-tip', async () => {
    window.location.hash = '#/vault/c/all';
    await openUnlocked({ exportFail: true });
    fireEvent.pointerDown(screen.getByTestId(`notes-more-${NID}`), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByTestId(`notes-more-${NID}`));
    fireEvent.click(await screen.findByTestId(`notes-from-vault-${NID}`));
    expect((await screen.findByTestId('notes-moveout-tip')).textContent).toBe('没移出去，稍后再试一次');
    expect(screen.queryByTestId('notes-conv-tip')).toBeNull();
  });
});