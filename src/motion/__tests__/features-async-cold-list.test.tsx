// 真实首屏走的路（FA-6 ② 审查 L6）：功能包没到时就挂上的列表（今天页、待办页第一次画），到了以后再删行、加行：
// • 删掉的行：打 data-state="leaving"、带 inert（审查 L3）、按原位绝对定位，淡出，播完才卸载；
// • 新加的行：打 entering、不接点按，从 opacity 0 淡到 1，播完去掉 entering；
// • 功能包到了会在 <html> 打 data-motion="ready"（审查 L5，e2e 等这个标记）。
// 单独一个文件：功能包的模块状态是共用的，features-async.test.tsx 那边的用例按“没到 → 到了”的顺序排着，插不进“没到时挂上的列表”
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => {
  let open!: () => void;
  const ready = new Promise<void>((ok) => (open = ok));
  return { ready, open: () => open() };
});
vi.mock('../feature-bundle.ts', async () => {
  await gate.ready;
  const { domMax } = await import('motion/react');
  return { default: domMax };
});

const { AppearItem, AppearList } = await import('../components.ts');
const { loadMotionFeatures, motionFeaturesReady, MOTION_READY_ATTR } = await import('../features.ts');

afterEach(() => {
  cleanup();
});

const wait = (ms: number) => act(() => new Promise<void>((ok) => setTimeout(ok, ms)));

function List({ ids }: { ids: string[] }) {
  return (
    <AppearList as="ul" data-testid="list">
      {ids.map((id) => (
        <AppearItem key={id} as="li" data-id={id}>
          <button type="button">{id}</button>
        </AppearItem>
      ))}
    </AppearList>
  );
}

describe('没到时挂上的列表，到了以后删行、加行（FA-6 ② 审查 L6）', () => {
  it('删行淡出、带 inert、播完才卸载；加行 entering、淡入到 1；<html> 打 data-motion="ready"', async () => {
    expect(motionFeaturesReady()).toBe(false);
    expect(document.documentElement.hasAttribute(MOTION_READY_ATTR)).toBe(false);
    const { container, rerender } = render(<List ids={['a', 'b', 'c']} />);
    const row = (id: string) => container.querySelector<HTMLElement>(`[data-id="${id}"]`);
    gate.open();
    await act(async () => {
      await loadMotionFeatures();
    });
    expect(motionFeaturesReady()).toBe(true);
    expect(document.documentElement.getAttribute(MOTION_READY_ATTR), '到了要打标记（e2e 等它）').toBe('ready');
    await wait(20);

    // 删 b
    rerender(<List ids={['a', 'c']} />);
    const b = row('b');
    expect(b, '删掉的行不能当场卸载（要淡出）').not.toBeNull();
    expect(b?.dataset['state']).toBe('leaving');
    expect(b?.hasAttribute('inert'), '离开途中键盘、读屏碰不到（审查 L3）').toBe(true);
    expect(b?.style.position).toBe('absolute');
    const op: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      await wait(16);
      const el = row('b');
      if (el) op.push(Number(el.style.opacity || '1'));
    }
    expect(op.some((x) => x < 1 && x > 0), `删掉的行在淡出：${op.join(',')}`).toBe(true);
    await waitFor(() => expect(row('b'), '淡完卸载').toBeNull(), { timeout: 3000 });
    expect(row('a')?.hasAttribute('inert'), '留下的行不带 inert').toBe(false);

    // 加 d
    rerender(<List ids={['a', 'c', 'd']} />);
    const d = row('d');
    expect(d?.dataset['state']).toBe('entering');
    expect(d?.style.pointerEvents).toBe('none');
    expect(d?.style.opacity, '从 0 起播').toBe('0');
    expect(d?.hasAttribute('inert')).toBe(false);
    await waitFor(() => expect(row('d')?.dataset['state']).not.toBe('entering'), { timeout: 3000 });
    expect(row('d')?.style.opacity).toBe('1');
    expect(row('d')?.style.pointerEvents).not.toBe('none');
  });
});
