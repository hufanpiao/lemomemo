// 打字条开着时在历史里垫一条（hooks/type-entry.ts；负责人 11-18 录屏“展开以后左滑退出的时候会闪一下简约输入框”）：
// 画出来之前压一条同地址、带 lemoType 的历史（深度、载入编号照抄）；收起时退掉；被浏览器后退 / 侧滑退掉时叫 onBack；
// StrictMode 卸了又挂只压一条、不退；从这一条“展开编辑”（router goHref）是换掉它、不再多压
import { StrictMode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goHref, padMark, stateOf } from '../../../app/router.ts';
import { useTypeEntry } from '../hooks/type-entry.ts';

function Bar({ open, onBack }: { open: boolean; onBack: () => void }) {
  useTypeEntry(open, onBack);
  return null;
}

/** 等 setTimeout(0) 的退出和 history.back() 的 popstate（jsdom 里也是异步） */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};

beforeEach(() => {
  window.history.replaceState({ lemoDepth: 1, lemoDoc: 7 }, '', '#/today');
});
afterEach(async () => {
  cleanup();
  await settle();
});

describe('useTypeEntry', () => {
  it('打开时压一条同地址的历史，深度和载入编号照抄、多一个 lemoType', () => {
    render(<Bar open onBack={vi.fn()} />);
    expect(window.location.hash).toBe('#/today');
    expect(window.history.state).toEqual({ lemoDepth: 1, lemoDoc: 7, lemoType: padMark() });
  });

  it('收起时退掉这一条，不当成用户返回', async () => {
    const onBack = vi.fn();
    const r = render(<Bar open onBack={onBack} />);
    r.rerender(<Bar open={false} onBack={onBack} />);
    await settle();
    expect(stateOf('lemoType')).toBeUndefined();
    expect(window.history.state).toEqual({ lemoDepth: 1, lemoDoc: 7 });
    expect(onBack).not.toHaveBeenCalled();
  });

  it('开着时被后退（侧滑返回）退掉：叫 onBack 一次', async () => {
    const onBack = vi.fn();
    render(<Bar open onBack={onBack} />);
    window.history.back();
    await settle();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('StrictMode 卸了又挂：只压一条、不退（退一步就回到原来那条）', async () => {
    const onBack = vi.fn();
    render(
      <StrictMode>
        <Bar open onBack={onBack} />
      </StrictMode>,
    );
    await settle();
    expect(stateOf('lemoType')).toBe(padMark());
    window.history.back();
    await settle();
    expect(window.history.state).toEqual({ lemoDepth: 1, lemoDoc: 7 });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('从这一条换页（展开编辑）：换掉它、不多压，深度 + 1；之后卸掉也不再后退', async () => {
    const onBack = vi.fn();
    const r = render(<Bar open onBack={onBack} />);
    const n1 = window.history.length;
    await goHref('#/event/new', 'none');
    expect(window.history.length).toBe(n1);
    expect(window.location.hash).toBe('#/event/new');
    expect(stateOf('lemoType')).toBeUndefined();
    expect(stateOf('lemoDepth')).toBe(2);
    r.unmount();
    await settle();
    expect(window.location.hash).toBe('#/event/new');
    expect(onBack).not.toHaveBeenCalled();
  });
});
