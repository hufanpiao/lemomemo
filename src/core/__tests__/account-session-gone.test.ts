// BootResult.sessionGone（代码审查建议 1）：watchAccount 只在“会话没了”设闸时标上——本页的 SIGNED_OUT、别的标签页退出；
// 换账号不标。设置页申请注销后确认不了时，只有这一路设的闸才另记 deletion_unsure（features/settings/data/account-exit.ts）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBoot, resetBootForTest } from '../boot.ts';
import { clearAllCollections } from '../store.ts';
import { setup } from './account-watch-harness.ts';

beforeEach(() => {
  clearAllCollections();
});
afterEach(() => {
  vi.restoreAllMocks();
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('BootResult.sessionGone', () => {
  it('本页的 SIGNED_OUT：设闸的同一刻标上', async () => {
    const { boot, signedOut, session } = await setup();
    session.id = null;
    expect(boot.sessionGone).toBeFalsy();
    signedOut();
    expect(boot.switching).toBe(true);
    expect(boot.sessionGone).toBe(true);
  });

  it('别的标签页退出（会话里没人了）：标上', async () => {
    const { boot, storage } = await setup();
    storage(null);
    expect(boot.switching).toBe(true);
    expect(boot.sessionGone).toBe(true);
  });

  it('换账号（会话里换成了别人）：设闸但不标', async () => {
    const { boot, storage } = await setup();
    storage('B');
    expect(boot.switching).toBe(true);
    expect(boot.sessionGone).toBeFalsy();
  });
});
