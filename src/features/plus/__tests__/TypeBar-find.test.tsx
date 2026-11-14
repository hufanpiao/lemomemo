// 打字条“看起来是要查找”（B4b-2；线框 sPlus“点按＋打字：预览先显示查找”；ui/TypeBar.tsx、hooks/useTypeBar.ts 的 find）
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import type { WriteResult } from '../../../core/write.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { findOpenSnapshot } from '../../smart-search/hooks/find-open.ts';
import type { Writer } from '../data/capture-save.ts';
import TypeBar from '../ui/TypeBar.tsx';

const NOW = msAt('2026-11-02', 12 * 60, 'UTC');
const OK: WriteResult = { ok: true, item: null };

function setup() {
  const writer = { insert: vi.fn<Writer['insert']>(async () => OK), patch: vi.fn<Writer['patch']>(async () => OK) };
  const onClose = vi.fn();
  render(<TypeBar day={null} writer={writer} online={() => true} onExpand={vi.fn()} onClose={onClose} />);
  return { writer, onClose, input: screen.getByTestId('type-input') };
}

beforeEach(() => {
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  uiStore.getState().setLocale('zh-CN');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('打字条：看起来是要查找', () => {
  it('本机规则判成查找：出“找：…”，按钮变“查找”；回车打开查找面板、不写任何记录、关掉打字条', async () => {
    const { writer, onClose, input } = setup();
    fireEvent.change(input, { target: { value: '帮我找牙医的记录' } });
    expect(screen.getByTestId('type-find-head').textContent).toBe('看起来是要查找 · Enter 查找');
    expect(screen.getByTestId('type-find').textContent).toContain('找：牙医的记录');
    expect(screen.getByRole('button', { name: '查找' })).toBeTruthy();
    await act(async () => {
      fireEvent.submit(screen.getByTestId('type-bar'));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(findOpenSnapshot()).toMatchObject({ q: '牙医的记录', from: 'plus' }));
    expect(writer.insert).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点“找：…”改成记下：预览回到“会记成这样”，按钮回到“记下”；再改字重新判断', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: '查一下 合同' } });
    fireEvent.click(screen.getByTestId('type-find'));
    expect(screen.queryByTestId('type-find')).toBeNull();
    expect(screen.getByRole('button', { name: '记下' })).toBeTruthy();
    fireEvent.change(input, { target: { value: '查一下 合同2' } });
    expect(screen.getByTestId('type-find')).toBeTruthy();
  });

  it('普通的一句、带时间范围的查找（归 B4b-3）：照旧记下', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: '明天下午3点去银行' } });
    expect(screen.queryByTestId('type-find')).toBeNull();
    fireEvent.change(input, { target: { value: '这周有什么日程' } });
    expect(screen.queryByTestId('type-find')).toBeNull();
  });
});
