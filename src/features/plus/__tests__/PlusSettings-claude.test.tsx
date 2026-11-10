// 设置 › 在 Claude 聊天里记事（B3 FA-4；R-369 照线框 s13；代码审 S2、安全审 1～3）。从 PlusSettings.test.tsx 拆出来（max-lines），打桩同那一份
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type * as LinkApi from '../data/claude-link-api.ts';
import type * as Env from '../../../platform/env.ts';

const usage = vi.fn();
const list = vi.fn();
const create = vi.fn();
const disc = vi.fn();
const mic = vi.fn();
const writeAi = vi.fn();
const toSub = vi.fn();
let exe = false;
let apple = true;
let settings: { id: string; key: string; value: unknown }[] = [];

vi.mock('../data/ai-usage-api.ts', () => ({ readAiUsage: () => usage() }));
vi.mock('../data/claude-link-api.ts', async (orig) => ({
  ...(await orig<typeof LinkApi>()),
  listLinks: () => list(),
  createLink: () => create(),
  disconnectAll: () => disc(),
}));
vi.mock('../../../platform/perm-mic.ts', () => ({ micPermission: () => mic() }));
vi.mock('../../../platform/env.ts', async (orig) => ({ ...(await orig<typeof Env>()), isTauri: () => exe, isAppleMobile: () => apple }));
vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: () => settings }));
vi.mock('../../../core/ai-settings.ts', () => ({ writeAiSwitch: (sw: unknown) => writeAi(sw) }));
vi.mock('../../../app/router-sub.ts', () => ({ navigateSub: (...a: unknown[]) => toSub(...a) }));
const { default: PlusSettings } = await import('../ui/PlusSettings.tsx');

const NOW = Date.now();
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const aiOn = (v: boolean): void => {
  settings = [{ id: 's1', key: 'ai.enabled', value: v }];
};

beforeEach(() => {
  exe = false;
  apple = true;
  aiOn(true);
  uiStore.setState({ locale: 'zh-CN' });
  usage.mockResolvedValue({ ok: true, value: { used: 18, limit: 50 } });
  list.mockResolvedValue({ ok: true, value: [] });
  mic.mockResolvedValue('granted');
  writeAi.mockResolvedValue({ ok: true, item: null });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('在 Claude 聊天里记事', () => {
  const linked = (made = NOW - DAY) => ({ ok: true, value: [{ id: 'a', created_at: iso(made), last_used_at: null, revoked_at: null }] });

  it('首页的值：没有码 → 没有连接；有有效码 → 已连接', async () => {
    const { container, unmount } = render(<PlusSettings part="claude" view="value" />);
    await waitFor(() => expect(container.textContent).toBe('没有连接'));
    unmount();
    list.mockResolvedValue(linked());
    const r = render(<PlusSettings part="claude" view="value" />);
    await waitFor(() => expect(r.container.textContent).toBe('已连接'));
  });

  it('二级页（线框 s13）：开关开着、连接码一行带最新码的日期、断开连接可点', async () => {
    // UTC 12:00：UTC、首尔、洛杉矶三个时区都是 10 月 24 日（CI 在三个时区各跑一遍）
    list.mockResolvedValue(linked(Date.UTC(2026, 9, 24, 12)));
    render(<PlusSettings part="claude" view="page" />);
    await waitFor(() => expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).checked).toBe(true));
    expect(screen.getByTestId('plus-set-cla-code-info').textContent).toMatch(/^只能新增，不能看、改、删 · 10月24日 连接$/);
    expect((screen.getByTestId('plus-set-cla-disconnect') as HTMLButtonElement).disabled).toBe(false);
  });

  it('没连着：开关关着、连接码一行不带日期、断开连接灰掉', async () => {
    render(<PlusSettings part="claude" view="page" />);
    await waitFor(() => expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).disabled).toBe(false));
    expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId('plus-set-cla-code-info').textContent).toBe('只能新增，不能看、改、删');
    expect((screen.getByTestId('plus-set-cla-disconnect') as HTMLButtonElement).disabled).toBe(true);
  });

  it('读不出来：开关灰掉，写“读不出来”', async () => {
    list.mockResolvedValue({ ok: false, err: 'offline' });
    render(<PlusSettings part="claude" view="page" />);
    expect(await screen.findByText('读不出来')).toBeTruthy();
    expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).disabled).toBe(true);
  });

  it('打开开关 = 生成连接码：明文只显示这一次、是纯文字不是链接；变成已连接', async () => {
    create.mockResolvedValue({ ok: true, value: { token: 'lemo_xxxxxxxxxxxx', expiresAt: '2027-05-08T00:00:00Z' } });
    const { unmount } = render(<PlusSettings part="claude" view="page" />);
    await waitFor(() => expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(screen.getByTestId('plus-set-cla-switch'));
    });
    const code = await screen.findByTestId('plus-set-cla-code');
    expect(code.textContent).toBe('lemo_xxxxxxxxxxxx');
    expect(code.querySelector('a')).toBeNull();
    expect(code.closest('a')).toBeNull();
    expect(screen.getByTestId('plus-set-cla-code-meta').textContent).toMatch(/过期$/);
    expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).checked).toBe(true);
    // 离开这一页再进来就看不到了
    unmount();
    render(<PlusSettings part="claude" view="page" />);
    await screen.findByTestId('plus-set-cla-code-info');
    expect(screen.queryByText('lemo_xxxxxxxxxxxx')).toBeNull();
  });

  it.each([
    ['too_many', '连接码最多 5 个，先断开连接再生成'],
    ['rate_limited', '今天生成的次数用完了，明天再试'],
    ['offline', '没网，联网后再试'],
    ['signed_out', '登录过期了，请重新登录'],
    ['failed', '没成功，请再试一次'],
  ] as const)('生成失败 %s → 提示', async (err, text) => {
    create.mockResolvedValue({ ok: false, err });
    render(<PlusSettings part="claude" view="page" />);
    await waitFor(() => expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(screen.getByTestId('plus-set-cla-switch'));
    });
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByTestId('plus-set-cla-code')).toBeNull();
    expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).checked).toBe(false);
  });

  it.each([['断开连接一行', 'plus-set-cla-disconnect'], ['关掉开关', 'plus-set-cla-switch']] as const)(
    '%s：码一起作废、写“已断开”、变成没有连接',
    async (_n, id) => {
      // 断开后按服务器重读（安全审 1）：第二次读到的是空的
      list.mockResolvedValueOnce(linked());
      disc.mockResolvedValue({ ok: true, value: null });
      render(<PlusSettings part="claude" view="page" />);
      await waitFor(() => expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).checked).toBe(true));
      await act(async () => {
        fireEvent.click(screen.getByTestId(id));
      });
      expect(disc).toHaveBeenCalledTimes(1);
      expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).checked).toBe(false);
      expect(screen.getByText('已断开，Claude 不能再记了；需要时可以重新连接')).toBeTruthy();
    },
  );

  it('断开失败：照旧已连接，写原因', async () => {
    list.mockResolvedValue(linked());
    disc.mockResolvedValue({ ok: false, err: 'offline' });
    render(<PlusSettings part="claude" view="page" />);
    await waitFor(() => expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).checked).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByTestId('plus-set-cla-disconnect'));
    });
    expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('没网，联网后再试')).toBeTruthy();
  });

  it('断开请求没报错、服务器重读仍连着（安全审 1：RLS 一行没改）：不写“已断开”，写没成功', async () => {
    list.mockResolvedValue(linked());
    disc.mockResolvedValue({ ok: true, value: null });
    render(<PlusSettings part="claude" view="page" />);
    await waitFor(() => expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).checked).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByTestId('plus-set-cla-disconnect'));
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText('已断开，Claude 不能再记了；需要时可以重新连接')).toBeNull();
    expect(screen.getByText('没成功，请再试一次')).toBeTruthy();
  });

  it('断开超时、服务器其实已断开（安全审 2）：按重读的结果写“已断开”', async () => {
    list.mockResolvedValueOnce(linked());
    disc.mockResolvedValue({ ok: false, err: 'offline' });
    render(<PlusSettings part="claude" view="page" />);
    await waitFor(() => expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).checked).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByTestId('plus-set-cla-disconnect'));
    });
    expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText('已断开，Claude 不能再记了；需要时可以重新连接')).toBeTruthy();
  });

  it('断开后重读也读不出来：不写“已断开”，写“读不出来”', async () => {
    list.mockResolvedValueOnce(linked()).mockResolvedValue({ ok: false, err: 'offline' });
    disc.mockResolvedValue({ ok: true, value: null });
    render(<PlusSettings part="claude" view="page" />);
    await waitFor(() => expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).checked).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByTestId('plus-set-cla-disconnect'));
    });
    expect(screen.queryByText('已断开，Claude 不能再记了；需要时可以重新连接')).toBeNull();
    expect(screen.getByText('读不出来')).toBeTruthy();
  });

  it('生成出错（安全审 2）：按服务器重读一次；服务器上其实建好了就显示已连接、不显示明文', async () => {
    list.mockResolvedValueOnce({ ok: true, value: [] }).mockResolvedValue(linked());
    create.mockResolvedValue({ ok: false, err: 'offline' });
    render(<PlusSettings part="claude" view="page" />);
    await waitFor(() => expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(screen.getByTestId('plus-set-cla-switch'));
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId('plus-set-cla-code')).toBeNull();
    expect(screen.getByText('没网，联网后再试')).toBeTruthy();
  });

  it('连点两下生成（代码审 S2）：只发一次', async () => {
    let done: (v: unknown) => void = () => undefined;
    create.mockReturnValue(new Promise((r) => (done = r)));
    render(<PlusSettings part="claude" view="page" />);
    await waitFor(() => expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).disabled).toBe(false));
    const sw = screen.getByTestId('plus-set-cla-switch');
    fireEvent.click(sw);
    fireEvent.click(sw);
    await act(async () => {
      done({ ok: true, value: { token: 'lemo_x1', expiresAt: null } });
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('页面切到后台（安全审 3）：明文码清掉，切回来也不再显示', async () => {
    create.mockResolvedValue({ ok: true, value: { token: 'lemo_hide_me', expiresAt: null } });
    render(<PlusSettings part="claude" view="page" />);
    await waitFor(() => expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(screen.getByTestId('plus-set-cla-switch'));
    });
    expect(await screen.findByText('lemo_hide_me')).toBeTruthy();
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    vis.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(screen.queryByText('lemo_hide_me')).toBeNull();
    expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).checked).toBe(true);
    vis.mockRestore();
  });

  it('生成请求在路上时切到后台（复审 R1）：回包不显示明文码，按服务器重读为已连接', async () => {
    let done: (v: unknown) => void = () => undefined;
    create.mockReturnValue(new Promise((r) => (done = r)));
    list.mockResolvedValueOnce({ ok: true, value: [] }).mockResolvedValue(linked());
    render(<PlusSettings part="claude" view="page" />);
    await waitFor(() => expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('plus-set-cla-switch'));
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      done({ ok: true, value: { token: 'lemo_in_flight', expiresAt: null } });
    });
    vis.mockRestore();
    expect(screen.queryByText('lemo_in_flight')).toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
    expect((screen.getByTestId('plus-set-cla-switch') as HTMLInputElement).checked).toBe(true);
  });
});
