// AiProviderSettings part="adminOnly"（设置首页“邀请朋友”一行用）：和“AI 服务商”一行同一个判断——mine 读到了、admin 为 true 才画 children；
// 不是管理员、还没读到、读不出来都不画
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MineRes } from '../../../../shared/schema/ai-provider.ts';
import type * as Api from '../data/provider-api.ts';

const readMine = vi.fn();
vi.mock('../data/provider-api.ts', async (orig) => ({ ...(await orig<typeof Api>()), readMine: () => readMine() }));
const { default: Parts } = await import('../ui/AiProviderSettings.tsx');
const { mineBox } = await import('../data/store.ts');

const mine = (admin: boolean): MineRes => ({ admin, project: 'gemini', own: null, images: true });
const kid = <span data-testid="kid">x</span>;
const both = () => (
  <>
    <Parts part="adminOnly">{kid}</Parts>
    <Parts part="adminRow" label="AI 服务商" onOpen={() => undefined} />
  </>
);

beforeEach(() => {
  mineBox.set({ kind: 'loading' });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('adminOnly：只有管理员才画', () => {
  it('管理员：children 和“AI 服务商”一行都画', async () => {
    readMine.mockResolvedValue({ ok: true, value: mine(true) });
    render(both());
    await screen.findByTestId('kid');
    expect(screen.getByTestId('settings-ai-provider-entry')).toBeTruthy();
  });

  it('不是管理员：两样都不画', async () => {
    readMine.mockResolvedValue({ ok: true, value: mine(false) });
    render(both());
    await vi.waitFor(() => expect(mineBox.get().kind).toBe('ok'));
    expect(screen.queryByTestId('kid')).toBeNull();
    expect(screen.queryByTestId('settings-ai-provider-entry')).toBeNull();
  });

  it('还没读到、读不出来：不画', async () => {
    readMine.mockResolvedValue({ ok: false, err: 'offline' });
    render(both());
    expect(screen.queryByTestId('kid')).toBeNull();
    await vi.waitFor(() => expect(mineBox.get().kind).toBe('error'));
    expect(screen.queryByTestId('kid')).toBeNull();
  });
});
