// 设置 › 吉祥物的预览：放哪一只、#2 的权限分支、同时只有一个实例、卸载销毁
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRIVATE_URL } from '../data/mascot-private.ts';
import { mascotValue, MASCOT_KEY } from '../data/mascot-setting.ts';
import MascotSettings from '../ui/MascotSettings.tsx';
import { stageId } from './stage-id.ts';

const h = vi.hoisted(() => ({
  admin: null as boolean | null,
  rows: [] as Record<string, unknown>[],
  live: 0,
  calls: [] as { id: string; url: string; cb: { onReady?(): void; onFail?(): void } }[],
}));

vi.mock('../hooks/useMascotAdmin.ts', () => ({ useMascotAdmin: () => h.admin }));
vi.mock('../../../kit/hooks/useSettingWriter.ts', () => ({ useSettingWriter: () => ({ rows: h.rows, save: vi.fn(), error: false }) }));
vi.mock('../hooks/useMascotT.ts', () => ({ useMascotT: () => (k: string) => k }));
vi.mock('../../../platform/run-log-api.ts', () => ({ rlog: vi.fn() }));
vi.mock('../hooks/stage.ts', () => ({
  createStage: (_el: HTMLElement, def: { url: string }, cb: { onReady?(): void; onFail?(): void }) => {
    h.live += 1;
    h.calls.push({ id: stageId(def), url: def.url, cb });
    return { destroy: () => (h.live -= 1) };
  },
}));

const pick = (id: '2' | '19') => [{ id: 'k', key: MASCOT_KEY, value: mascotValue(id) }];

beforeEach(() => {
  h.admin = null;
  h.rows = [];
  h.live = 0;
  h.calls = [];
});
afterEach(cleanup);

describe('吉祥物预览', () => {
  it('管理员身份没读到、没选过：先不下载任何一只，单选列表也先不出（不先选中 Aldo 再跳）', () => {
    const v = render(<MascotSettings />);
    expect(h.calls).toEqual([]);
    expect(screen.queryByTestId('settings-mascot-23')).toBeNull();
    h.admin = true;
    v.rerender(<MascotSettings />);
    expect(screen.getByTestId('settings-mascot-2')).toBeTruthy();
    expect((screen.getByTestId('settings-mascot-2') as HTMLInputElement).checked).toBe(true);
  });

  it('普通账号存着 #2：放默认 Aldo，绝不碰私有文件，列表没有 #2', () => {
    h.admin = false;
    h.rows = pick('2');
    render(<MascotSettings />);
    expect(h.calls.map((c) => c.id)).toEqual(['23']);
    expect(h.calls.some((c) => c.url === PRIVATE_URL)).toBe(false);
    expect(screen.queryByTestId('settings-mascot-2')).toBeNull();
  });

  it('管理员默认放 #2，走私有下载地址', () => {
    h.admin = true;
    render(<MascotSettings />);
    expect(h.calls.map((c) => [c.id, c.url])).toEqual([['2', PRIVATE_URL]]);
  });

  it('换一只先销毁旧实例，卸载后一个不剩', () => {
    h.admin = false;
    const { rerender, unmount } = render(<MascotSettings />);
    expect(h.live).toBe(1);
    h.rows = pick('19');
    rerender(<MascotSettings />);
    expect(h.calls.map((c) => c.id)).toEqual(['23', '19']);
    expect(h.live).toBe(1);
    unmount();
    expect(h.live).toBe(0);
  });
});
