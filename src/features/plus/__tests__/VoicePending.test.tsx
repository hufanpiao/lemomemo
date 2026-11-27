// 待办编辑页顶上那一行（ui/VoicePending.tsx）：不是占位不画；整理中只有一行字；没整理成给“重试”，正在重传时禁用
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type { PendingState } from '../data/voice-pending.ts';

const st = vi.hoisted(() => ({ state: null as PendingState | null, retry: vi.fn() }));
vi.mock('../hooks/usePending.ts', () => ({ usePending: () => ({ state: st.state, retry: st.retry }) }));
const { default: VoicePending } = await import('../ui/VoicePending.tsx');

afterEach(() => {
  cleanup();
  st.retry.mockClear();
});

describe('待办编辑页：占位那一行', () => {
  it('不是占位（本机没留录音）：什么都不画', () => {
    st.state = null;
    render(<VoicePending id="a" />);
    expect(screen.queryByTestId('voice-pending')).toBeNull();
  });

  it('整理中：一行字，不出按钮', () => {
    uiStore.setState({ locale: 'zh-CN' });
    st.state = 'tidying';
    render(<VoicePending id="a" />);
    expect(screen.getByTestId('voice-pending').textContent).toBe('这段录音正在整理，好了会自动换成待办或日程');
    expect(screen.queryByTestId('voice-pending-retry')).toBeNull();
  });

  it('没整理成：给“重试”，点了交给 usePending；正在重传时禁用', () => {
    uiStore.setState({ locale: 'zh-CN' });
    st.state = 'failed';
    const { rerender } = render(<VoicePending id="a" />);
    expect(screen.getByTestId('voice-pending').textContent).toContain('这段录音还没整理成');
    fireEvent.click(screen.getByTestId('voice-pending-retry'));
    expect(st.retry).toHaveBeenCalledTimes(1);
    st.state = 'retrying';
    rerender(<VoicePending id="a" />);
    expect((screen.getByTestId('voice-pending-retry') as HTMLButtonElement).disabled).toBe(true);
  });
});
