// 隐私记页面（ui/VaultPage.tsx）：TC-B5-11（上锁后 DOM 里不留明文）、TC-B5-12（挂着时 <html data-rt="1">，卸掉还原；GlassBar 不碰隐私记）、
// TC-B5-13（解锁卡淡出 --dur-ui，上锁、多任务遮罩直接盖）、TC-B5-44（三个离开事件同步盖遮罩，59 秒回来去掉、61 秒上锁）、
// TC-B5-33（断网进不去）、TC-B5-48 ②（解锁后看得到自己的“最近删除”，永久删除要确认）
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { VaultNote, VaultRequest } from '../../../../shared/schema/vault.ts';
import { createVaultSession, type VaultSession } from '../data/session.ts';
import type { VaultApi, VaultFail, VaultResult } from '../data/vault-api.ts';
import { installVaultSession, SHIELD_ATTR, watchLeave } from '../hooks/useVault.ts';
import VaultPage from '../ui/VaultPage.tsx';
import { applyLook } from '../../../platform/look.ts';
import { make } from './session-fakes.ts';

vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: () => [] }));

const TOK = 't'.repeat(32);
const NID = '11111111-1111-4111-8111-111111111111';
const GONE = '22222222-2222-4222-8222-222222222222';
const SECRET = '血压 120/80';
const note = (over: Partial<VaultNote> = {}): VaultNote => ({
  id: NID, title: '体检报告', body: SECRET, category_id: null, created_at: 1, updated_at: 2, deleted_at: null, images: [], ...over,
});

function session(o: { offline?: boolean; purge?: () => void } = {}): VaultSession {
  const reply = (req: VaultRequest): unknown => {
    switch (req.action) {
      case 'status':
        return o.offline ? { ok: false, code: 'offline' } : { ok: true, set: true, locked_until: null, last_reset_at: null, webauthn: 0 };
      case 'list':
        return { ok: true, notes: [note(), note({ id: GONE, title: '旧的', body: '删掉的', deleted_at: 5 })], vault_token: TOK, expires_at: 9e12 };
      case 'purge':
        o.purge?.();
        return { ok: true, purged: 1, vault_token: TOK, expires_at: 9e12 };
      default:
        return { ok: true, vault_token: TOK, expires_at: 9e12 };
    }
  };
  const api: VaultApi = {
    async call<S extends z.ZodType>(req: VaultRequest, _t: string | null, schema: S): Promise<VaultResult<z.infer<S>>> {
      const v = reply(req);
      if ((v as { ok?: unknown }).ok === false) return v as VaultFail;
      const p = schema.safeParse(v);
      return p.success ? { ok: true, value: p.data } : { ok: false, code: 'unknown' };
    },
    imageGet: async () => ({ ok: true, value: new Blob(['x']) }),
    imageUpload: async () => ({ ok: true, value: true }),
    // 附件（vault-file）这里用不到
    fileCall: async () => ({ ok: false, code: 'unknown' }),
    fileGet: async () => ({ ok: false, code: 'unknown' }),
    fileUpload: async () => ({ ok: false, code: 'unknown' }),
    fileEnd: () => undefined,
  };
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

async function openUnlocked() {
  s = session();
  installVaultSession(s);
  render(<VaultPage />);
  await screen.findByTestId('vault-unlock-card');
  await act(async () => {
    await s.unlock('1234');
  });
  await screen.findByTestId('vault-list');
}

describe('解锁、上锁', () => {
  it('线框 s9：用不了 Face ID 时解锁卡只有“输入密码”“取消”；点了进整页密码页，顶栏“‹ 随手记 … 取消”，提示在圆点下、键盘上；手机宽度不出快捷键提示', async () => {
    s = session();
    installVaultSession(s);
    render(<VaultPage />);
    const card = await screen.findByTestId('vault-unlock-card');
    expect(screen.queryByTestId('vault-unlock-face')).toBeNull();
    expect([...card.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['输入密码', '取消']);
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
    // 线框 s9 PRIVLIST：行里只有日期、标题、分类，不出正文摘要
    expect(screen.getByTestId(`vault-row-${NID}`).textContent).toContain('体检报告');
    expect(document.body.textContent).not.toContain(SECRET);
    act(() => s.lock());
    await screen.findByTestId('vault-unlock-card');
    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain('体检报告');
    expect(screen.queryByTestId('vault-list')).toBeNull();
  });

  it('列表行的“⋯”：移出隐私记、删除，和编辑页底部两个按钮同一套动作', async () => {
    await openUnlocked();
    const out = vi.spyOn(s, 'exportNote').mockResolvedValue({ ok: true, value: { ok: true, vault_token: 't', expires_at: 0 } });
    const del = vi.spyOn(s, 'remove').mockResolvedValue({ ok: true, value: { ok: true, vault_token: 't', expires_at: 0 } });
    fireEvent.click(screen.getByTestId(`vault-more-${NID}`));
    fireEvent.click(await screen.findByTestId(`vault-out-${NID}`));
    expect(out).toHaveBeenCalledWith(NID);
    fireEvent.click(screen.getByTestId(`vault-more-${NID}`));
    fireEvent.click(await screen.findByTestId(`vault-del-${NID}`));
    expect(del).toHaveBeenCalledWith(NID);
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
  it('页面挂着时 <html data-rt="1">，中途皮肤重画也不被冲掉；卸掉后按设置重算（设置开着就还是 1）', async () => {
    s = session();
    installVaultSession(s);
    const base = { skin: 'glass', theme: 'light', rm: false, font: 'system' } as const;
    applyLook({ ...base, rt: false });
    expect(document.documentElement.hasAttribute('data-rt')).toBe(false);
    const r = render(<VaultPage />);
    expect(document.documentElement.getAttribute('data-rt')).toBe('1');
    applyLook({ ...base, theme: 'dark', rt: false });
    expect(document.documentElement.getAttribute('data-rt')).toBe('1');
    r.unmount();
    expect(document.documentElement.hasAttribute('data-rt')).toBe(false);
    applyLook({ ...base, rt: true });
    const r2 = render(<VaultPage />);
    r2.unmount();
    expect(document.documentElement.getAttribute('data-rt')).toBe('1');
    applyLook({ ...base, rt: false });
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

describe('11-14 整块评审第 22 条：令牌续不上（超过 12 小时、闲置过期）时编辑页的草稿不丢', () => {
  it('打字触发续期被拒 → 换成解锁卡、DOM 里没有草稿；解锁后草稿自动保存一次', async () => {
    const m = make({ renew: () => ({ ok: false, code: 'vault_locked' }) });
    installVaultSession(m.s);
    window.location.hash = '#/vault/new';
    render(<VaultPage />);
    await screen.findByTestId('vault-unlock-card');
    await act(async () => {
      await m.s.refreshStatus();
      await m.s.unlock('1234');
    });
    const title = await screen.findByTestId('vault-edit-title');
    fireEvent.change(title, { target: { value: '草稿标题' } });
    m.clock.ms += 6 * 60_000;
    await act(async () => {
      fireEvent.change(screen.getByTestId('vault-edit-body'), { target: { value: '还没存的正文' } });
      await new Promise((r) => setTimeout(r, 0));
    });
    await screen.findByTestId('vault-unlock-card');
    expect(document.body.textContent).not.toContain('还没存的正文');
    expect(m.calls.filter((c) => c.action === 'save')).toHaveLength(0);
    await act(async () => {
      await m.s.unlock('1234');
    });
    await waitFor(() => expect(m.calls.filter((c) => c.action === 'save')).toHaveLength(1));
    expect(m.calls.find((c) => c.action === 'save')?.req).toMatchObject({ title: '草稿标题', body: '还没存的正文' });
  });
});
