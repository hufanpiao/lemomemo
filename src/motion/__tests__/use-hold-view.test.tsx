// useHoldView（B2 FA-5 设计审查 M1）：打勾时留住按下之前的那一份 --dur-ui，再换成最新的；连着点接着留、重新计时；release 马上换；减少动态效果不留
import { act, cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHoldView } from '../components.ts';
import { dur } from '../tokens.ts';

const MS = 1000;
let api: { set(v: string): void; hold(): void; release(): void } | null = null;

function Harness() {
  const [live, set] = useState('a');
  const h = useHoldView(live);
  api = {
    set,
    hold: h.hold,
    release: h.release,
  };
  return <p data-testid="v">{`${h.view}|${String(h.holding)}`}</p>;
}
const shown = () => screen.getByTestId('v').textContent;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete document.documentElement.dataset['rm'];
});

describe('useHoldView', () => {
  it('hold 以后先画按下之前的那一份，--dur-ui 后换成最新的', () => {
    render(<Harness />);
    act(() => {
      api?.hold();
      api?.set('b');
    });
    expect(shown()).toBe('a|true');
    act(() => {
      vi.advanceTimersByTime(dur.ui * MS - 1);
    });
    expect(shown()).toBe('a|true');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shown()).toBe('b|false');
  });

  it('留着的期间又 hold：接着留同一份、重新计时', () => {
    render(<Harness />);
    act(() => {
      api?.hold();
      api?.set('b');
    });
    act(() => {
      vi.advanceTimersByTime((dur.ui * MS) / 2);
    });
    act(() => {
      api?.hold();
      api?.set('c');
    });
    act(() => {
      vi.advanceTimersByTime((dur.ui * MS) / 2 + 1);
    });
    expect(shown()).toBe('a|true');
    act(() => {
      vi.advanceTimersByTime(dur.ui * MS);
    });
    expect(shown()).toBe('c|false');
  });

  it('release 马上换成最新的', () => {
    render(<Harness />);
    act(() => {
      api?.hold();
      api?.set('b');
    });
    act(() => api?.release());
    expect(shown()).toBe('b|false');
  });

  it('减少动态效果：不留', () => {
    document.documentElement.dataset['rm'] = '1';
    render(<Harness />);
    act(() => {
      api?.hold();
      api?.set('b');
    });
    expect(shown()).toBe('b|false');
  });
});
