// 离开隐私记页自动上锁（负责人 11-15“离开隐私记页 1 分钟不自动上锁”；主持人定稿第 5 步）：
// • 会话按原因记离开时刻（'app'、'page'）；check() 任何一个满时长就锁；有离开原因时自己挂计时器到点 check
// • 隐私记页挂上、卸下经 useVaultPresence 报；页外解锁（移进隐私记弹的解锁卡）那一刻就记 'page'
// • 入口行读状态前先 check：离开隐私记页 61 秒回到随手记列表，入口行写“已上锁”；59 秒还是“已解锁”
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installVaultSession } from '../hooks/useVault.ts';
import VaultPage from '../ui/VaultPage.tsx';
import VaultParts from '../ui/VaultParts.tsx';
import { make, unlocked } from './session-fakes.ts';

vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: () => [] }));

afterEach(() => {
  cleanup();
  installVaultSession(null);
  window.location.hash = '';
  vi.useRealTimers();
});

describe('会话：按原因记离开时刻', () => {
  it('离开隐私记页 59 秒不锁、61 秒锁（check）', async () => {
    const { s, clock } = await unlocked();
    s.show(undefined, 1, 'page');
    s.hide(undefined, 'page');
    clock.ms += 59_000;
    expect(s.check()).toBe(false);
    expect(s.get().phase).toBe('unlocked');
    clock.ms += 2_000;
    expect(s.check()).toBe(true);
    expect(s.get().phase).toBe('locked');
  });

  it('59 秒内回到隐私记页：计时作废，之后在页上待多久都不锁', async () => {
    const { s, clock } = await unlocked();
    s.show(undefined, 1, 'page');
    s.hide(undefined, 'page');
    clock.ms += 59_000;
    expect(s.show(undefined, 1, 'page')).toBe(false);
    clock.ms += 10 * 60_000;
    expect(s.check()).toBe(false);
    expect(s.get().phase).toBe('unlocked');
  });

  it('隐私记页回来时离开满 61 秒：show 就锁上', async () => {
    const { s, clock } = await unlocked();
    s.show(undefined, 1, 'page');
    s.hide(undefined, 'page');
    clock.ms += 61_000;
    expect(s.show(undefined, 1, 'page')).toBe(true);
    expect(s.get().phase).toBe('locked');
  });

  it('页外解锁（隐私记页没挂着）：解锁那一刻就算离开了隐私记页', async () => {
    const { s, clock } = await unlocked();
    clock.ms += 61_000;
    expect(s.check()).toBe(true);
  });

  it('离开 App（默认原因 app）照旧：回来时离开满 61 秒锁；隐私记页挂着时 59 秒不锁', async () => {
    const { s, clock } = await unlocked();
    s.show(undefined, 1, 'page');
    s.hide();
    clock.ms += 59_000;
    expect(s.show()).toBe(false);
    s.hide();
    clock.ms += 61_000;
    expect(s.show()).toBe(true);
  });

  it('自动上锁时长按设置（5 分钟）：离开隐私记页 4 分钟不锁、5 分钟锁', async () => {
    const { s, clock } = await unlocked();
    s.show(undefined, 5, 'page');
    s.hide(undefined, 'page');
    clock.ms += 4 * 60_000;
    expect(s.check()).toBe(false);
    clock.ms += 60_000;
    expect(s.check()).toBe(true);
  });

  it('App 在前台、只是离开了隐私记页：计时器到点自己锁，不等用户回来', async () => {
    vi.useFakeTimers();
    const m = make();
    await m.s.refreshStatus();
    await m.s.unlock('1234');
    m.s.show(undefined, 1, 'page');
    m.s.hide(undefined, 'page');
    m.clock.ms += 59_000;
    vi.advanceTimersByTime(59_000);
    expect(m.s.get().phase).toBe('unlocked');
    m.clock.ms += 2_000;
    vi.advanceTimersByTime(2_000);
    expect(m.s.get().phase).toBe('locked');
  });
});

describe('界面：离开隐私记页回到随手记，入口行读状态前先 check', () => {
  async function leftVault() {
    const m = make();
    installVaultSession(m.s);
    window.location.hash = '#/vault';
    const page = render(<VaultPage />);
    await act(async () => {
      await m.s.refreshStatus();
      await m.s.unlock('1234');
    });
    await screen.findByTestId('vault-notes');
    page.unmount();
    window.location.hash = '#/notes';
    return m;
  }

  it('离开 59 秒：入口行还是“已解锁”', async () => {
    const m = await leftVault();
    m.clock.ms += 59_000;
    render(<VaultParts part="lockrow" />);
    expect((await screen.findByTestId('vault-lockrow')).textContent).toContain('已解锁');
    expect(m.s.get().phase).toBe('unlocked');
  });

  it('离开 61 秒：入口行一挂上就锁上、写“已上锁”', async () => {
    const m = await leftVault();
    m.clock.ms += 61_000;
    render(<VaultParts part="lockrow" />);
    expect((await screen.findByTestId('vault-lockrow')).textContent).toContain('已上锁');
    expect(m.s.get().phase).toBe('locked');
    expect(m.s.store.getSnapshot().notes).toEqual([]);
  });
});
