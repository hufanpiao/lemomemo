// “未同步，提醒可能不响”一行的“重试”（UNSYNCED-retry-ui，负责人 11-05 定方案 C）
// • 有发送失败、不是 gone 的项才出“重试”；只有待发、在途、gone 时只有提示、没有按钮
// • 点了：一次重试全部可重试的项（retryFailed 收到这些 op_id），按钮消失，焦点挪到提示行；重试期间再点不重复发
// • 中韩文案；行尾小标记照旧不是按钮
// • 提示文字和“重试”同一次渲染出来（审查 M1：按钮不晚一拍插进 role="status"）；重试出错（库已关以外）挪到微任务重新抛出（L1）
// outbox 用替身（core/boot 的 getBoot）：状态一变 remindRecs、retryRecs 换新集合并通知订阅者（算法同真 outbox 的 refresh）
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BootMod from '../../../core/boot.ts';
import type { OutboxItem } from '../../../core/outbox-types.ts';
import { mk, uid } from '../../../core/__tests__/outbox-fixtures.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';

const box = {
  items: [] as OutboxItem[],
  recs: new Set<string>() as ReadonlySet<string>,
  retry: new Set<string>() as ReadonlySet<string>,
  subs: new Set<() => void>(),
  /** 换一批项：remindRecs 按带提醒的重算、换新集合，通知订阅者 */
  set(items: OutboxItem[]) {
    box.items = items;
    box.recs = new Set(items.filter((i) => i.remind).map((i) => i.rec));
    box.retry = new Set(items.filter((i) => i.state === 'failed' && i.error !== 'gone' && box.recs.has(i.rec)).map((i) => i.rec));
    for (const f of [...box.subs]) f();
  },
};
let gate: Promise<void> = Promise.resolve();
let fail: Error | null = null;
const retryFailed = vi.fn(async (ids?: readonly string[]) => {
  await gate;
  if (fail) throw fail;
  box.set(box.items.map((i) => (ids?.includes(i.op_id) ? { ...i, state: 'pending', error: null } : i)));
});
const outbox = {
  subscribe(fn: () => void) {
    box.subs.add(fn);
    return () => {
      box.subs.delete(fn);
    };
  },
  getStatus: () => ({ remindRecs: box.recs, retryRecs: box.retry }),
  list: async () => box.items,
  retryFailed,
};
vi.mock('../../../core/boot.ts', async (orig) => ({ ...(await orig<typeof BootMod>()), getBoot: () => ({ outbox }) }));

const { default: UnsyncedRemindHint } = await import('../ui/UnsyncedRemind.tsx');
const { default: UnsyncedRemindMark } = await import('../ui/UnsyncedRemindMark.tsx');

const item = (seq: number, n: number, over: Partial<OutboxItem>): OutboxItem => ({ ...mk({ seq, id: uid(n) }), remind: true, ...over });
const failed = (seq: number, n: number, over: Partial<OutboxItem> = {}) => item(seq, n, { state: 'failed', error: '23503', ...over });

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  retryFailed.mockClear();
  gate = Promise.resolve();
  fail = null;
  box.subs.clear();
  box.set([]);
});
afterEach(cleanup);

describe('未同步提示行的“重试”', () => {
  it('有发送失败的项：提示后面出“重试”；点了重试全部可重试项（同一条记录不带提醒的那项也一起，gone 不算），按钮消失、焦点到提示行', async () => {
    box.set([failed(1, 1), failed(2, 1, { remind: false }), failed(3, 2), item(4, 3, { state: 'failed', error: 'gone' }), item(5, 4, { state: 'pending' })]);
    render(<UnsyncedRemindHint />);
    const btn = await screen.findByRole('button', { name: '重试' });
    expect(screen.getByTestId('remind-unsynced-hint').textContent).toBe('未同步，提醒可能不响重试');
    btn.focus();
    fireEvent.click(btn);
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
    expect(retryFailed).toHaveBeenCalledTimes(1);
    expect(retryFailed).toHaveBeenCalledWith(['op1', 'op2', 'op3']);
    // 还没回执：提示还在（这几条仍未同步），焦点在提示行上
    expect(screen.getByTestId('remind-unsynced-hint')).toBe(document.activeElement);
    expect(screen.getByTestId('remind-unsynced-hint').textContent).toBe('未同步，提醒可能不响');
  });

  it('只有待发、在途、gone：只有提示，没有“重试”', async () => {
    box.set([item(1, 1, { state: 'pending' }), item(2, 2, { state: 'inflight' }), item(3, 3, { state: 'failed', error: 'gone' })]);
    render(<UnsyncedRemindHint />);
    expect(await screen.findByTestId('remind-unsynced-hint')).toBeTruthy();
    await act(async () => undefined);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('后来又失败了：按钮重新出来；全部同步上：整行消失', async () => {
    box.set([item(1, 1, { state: 'pending' })]);
    render(<UnsyncedRemindHint />);
    await screen.findByTestId('remind-unsynced-hint');
    act(() => box.set([failed(1, 1)]));
    expect(await screen.findByRole('button', { name: '重试' })).toBeTruthy();
    act(() => box.set([]));
    expect(screen.queryByTestId('remind-unsynced-hint')).toBeNull();
  });

  it('重试还没完成时再点：不重复发，按钮 aria-disabled', async () => {
    let open = (): void => undefined;
    gate = new Promise<void>((r) => (open = r));
    box.set([failed(1, 1)]);
    render(<UnsyncedRemindHint />);
    const btn = await screen.findByRole('button', { name: '重试' });
    fireEvent.click(btn);
    await waitFor(() => expect(btn.getAttribute('aria-disabled')).toBe('true'));
    fireEvent.click(btn);
    // retryUnsynced 先 await list() 再调 retryFailed：等微任务跑完再数
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(retryFailed).toHaveBeenCalledTimes(1);
    await act(async () => open());
    expect(retryFailed).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
  });

  it('焦点不在按钮上时（比如用手指点的、焦点在别处）：按钮消失不抢焦点', async () => {
    box.set([failed(1, 1)]);
    render(
      <>
        <input data-testid="other" />
        <UnsyncedRemindHint />
      </>,
    );
    const btn = await screen.findByRole('button', { name: '重试' });
    const other = screen.getByTestId('other');
    other.focus();
    fireEvent.click(btn);
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
    expect(document.activeElement).toBe(other);
  });

  it('文字和“重试”同一次渲染：render 之后不等任何异步，按钮已经在（M1）；全部同步上时整行和按钮一起消失', () => {
    box.set([failed(1, 1)]);
    render(<UnsyncedRemindHint />);
    expect(screen.getByTestId('remind-unsynced-hint').textContent).toBe('未同步，提醒可能不响重试');
    act(() => box.set([]));
    expect(screen.queryByTestId('remind-unsynced-hint')).toBeNull();
  });

  it('重试出错（库已关以外）：不吞，挪到微任务重新抛出（走全局 js_error，L1）；按钮恢复可点', async () => {
    const queued: (() => void)[] = [];
    const spy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((fn) => void queued.push(fn));
    fail = new Error('坏了');
    box.set([failed(1, 1)]);
    render(<UnsyncedRemindHint />);
    const btn = screen.getByRole('button', { name: '重试' });
    fireEvent.click(btn);
    await waitFor(() => expect(queued.length).toBe(1));
    spy.mockRestore();
    expect(() => queued[0]?.()).toThrow('坏了');
    await waitFor(() => expect(btn.getAttribute('aria-disabled')).toBeNull());
  });

  it('韩文：다시 시도', async () => {
    uiStore.getState().setLocale('ko-KR');
    box.set([failed(1, 1)]);
    render(<UnsyncedRemindHint />);
    expect(await screen.findByRole('button', { name: '다시 시도' })).toBeTruthy();
  });

  it('行尾小标记照旧只显示、不是按钮（它在整行按钮里）', async () => {
    box.set([failed(1, 1)]);
    render(<UnsyncedRemindMark table="todos" id={uid(1)} />);
    expect(screen.getByTestId('remind-unsynced-mark').tagName).toBe('SPAN');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
