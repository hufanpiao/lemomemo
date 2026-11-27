// 设置 › 语音与 AI（B3 FA-4；R-369 照线框 s13 补齐）：首页的值、二级页正文。Claude 那一节在 PlusSettings-claude.test.tsx
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

describe('语音与 AI', () => {
  it('用量读不出来写“读不出来”，不写 0 次', async () => {
    usage.mockResolvedValue({ ok: false, err: 'offline' });
    render(<PlusSettings part="voiceAi" view="page" />);
    await waitFor(() => expect(screen.getByTestId('plus-set-ai-used').textContent).toContain('读不出来'));
  });

  it('没有 ai.enabled 这一行：当关着', async () => {
    settings = [];
    render(<PlusSettings part="voiceAi" view="page" />);
    await waitFor(() => expect((screen.getByTestId('plus-set-ai-organize') as HTMLInputElement).checked).toBe(false));
  });

  it('二级页：麦克风、AI 整理开关、用量和进度条、恢复时刻、说明', async () => {
    render(<PlusSettings part="voiceAi" view="page" />);
    await waitFor(() => expect(screen.getByTestId('plus-set-mic-value').textContent).toBe('已允许'));
    expect((screen.getByTestId('plus-set-ai-organize') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('plus-set-ai-used').textContent).toContain('今天 AI 用了 18 次 / 共 50 次');
    expect(screen.getByTestId('plus-set-ai-reset').textContent).toMatch(/^说一次话算 1 次 · 每天 \d{2}:\d{2} 恢复$/);
    const bar = screen.getByRole('progressbar', { name: '今天 AI 用量' });
    expect(bar.getAttribute('aria-valuenow')).toBe('18');
    expect(bar.getAttribute('aria-valuemax')).toBe('50');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('36%');
  });

  it('进度条：超过上限按满格算', async () => {
    usage.mockResolvedValue({ ok: true, value: { used: 60, limit: 50 } });
    render(<PlusSettings part="voiceAi" view="page" />);
    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%');
  });

  it('管理员（服务器 ai_unlimited）：写“今天 AI 用了 N 次 · 不限”，不写“/ 共 50 次”，不画进度条', async () => {
    usage.mockResolvedValue({ ok: true, value: { used: 60, limit: 50, unlimited: true } });
    render(<PlusSettings part="voiceAi" view="page" />);
    await waitFor(() => expect(screen.getByTestId('plus-set-ai-used').textContent).toContain('今天 AI 用了 60 次 · 不限'));
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByTestId('plus-set-ai-reset')).toBeTruthy();
  });

  it('说明只有一套（11-24 系统识别删掉，原来 R-369 按设备分两套）：用完后语音先停用、用键盘记，“明天恢复”；不再提手机自带识别', async () => {
    for (const a of [true, false]) {
      apple = a;
      const { unmount } = render(<PlusSettings part="voiceAi" view="page" />);
      const note = await screen.findByTestId('plus-set-ai-note');
      expect(note.textContent).toContain('用完后语音先停用，可以用键盘记');
      expect(note.textContent).toContain('明天恢复');
      expect(note.textContent).not.toContain('自带识别');
      unmount();
    }
  });

  it('关掉 AI 整理：经唯一写法写 ai.enabled = false，不去告知页', async () => {
    render(<PlusSettings part="voiceAi" view="page" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('plus-set-ai-organize'));
    });
    expect(writeAi).toHaveBeenCalledWith({ key: 'ai.enabled', value: false });
    expect(toSub).not.toHaveBeenCalled();
  });

  it('关掉时抛错（代码审 S5）：也提示，不留未处理的拒绝', async () => {
    writeAi.mockRejectedValue(new Error('x'));
    render(<PlusSettings part="voiceAi" view="page" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('plus-set-ai-organize'));
    });
    expect(await screen.findByText('没关上，请再试一次')).toBeTruthy();
  });

  it('关掉写不进本机：提示，开关照旧', async () => {
    writeAi.mockResolvedValue({ ok: false, reason: 'db' });
    render(<PlusSettings part="voiceAi" view="page" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('plus-set-ai-organize'));
    });
    expect(await screen.findByText('没关上，请再试一次')).toBeTruthy();
    expect((screen.getByTestId('plus-set-ai-organize') as HTMLInputElement).checked).toBe(true);
  });

  it('打开 AI 整理：一律先去告知页 #/onboarding/ai（架构 15.5 X5），不在这里写 ai.enabled', async () => {
    aiOn(false);
    render(<PlusSettings part="voiceAi" view="page" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('plus-set-ai-organize'));
    });
    expect(toSub).toHaveBeenCalledWith('onboarding', 'ai');
    expect(writeAi).not.toHaveBeenCalled();
  });

  it.each([
    ['denied', '未允许'],
    ['unknown', '还没问过'],
  ] as const)('麦克风 %s → %s', async (s, text) => {
    mic.mockResolvedValue(s);
    render(<PlusSettings part="voiceAi" view="page" />);
    await waitFor(() => expect(screen.getByTestId('plus-set-mic-value').textContent).toBe(text));
  });

  it('exe 不显示麦克风一行（R-90），也不去问；AI 整理开关照常有', async () => {
    exe = true;
    render(<PlusSettings part="voiceAi" view="page" />);
    await waitFor(() => expect(screen.getByTestId('plus-set-ai-used').textContent).toContain('18'));
    expect(screen.queryByTestId('plus-set-mic')).toBeNull();
    expect(mic).not.toHaveBeenCalled();
    expect(screen.getByTestId('plus-set-ai-organize')).toBeTruthy();
  });

  it('韩文', async () => {
    uiStore.setState({ locale: 'ko-KR' });
    render(<PlusSettings part="voiceAi" view="page" />);
    await waitFor(() => expect(screen.getByTestId('plus-set-ai-used').textContent).toContain('오늘 AI 18회 사용 / 총 50회'));
  });
});
