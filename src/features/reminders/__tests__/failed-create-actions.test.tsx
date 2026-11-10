// R-378：“未同步”提示条里新建失败、码不能重试的记录的“另存为新的一条”“放弃”（FailedCreateActions，按需下载）
// • 只认 failed 的 insert、canRetryUnsynced 为假的；能重试的（走原有“重试”）、失败的 patch 不出按钮
// • 点了：每条这样的记录各调一次 resolveFailedCreate(table, id, mode)；期间再点不重复做
// • 全是 settings 时只出“放弃”（重开页面后才被拒、没有 ai-settings 监听的也能收尾；R-378 复查必改）；没处理成给一句话（代码审查可选项）
// • 中韩文案
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveFailedCreateImpl } from '../../../core/outbox-failed-create.ts';
import type { OutboxItem } from '../../../core/outbox-types.ts';
import { outboxCtx } from '../../../core/outbox.ts';
import { clearAllCollections } from '../../../core/store.ts';
import { mk, setup, uid } from '../../../core/__tests__/outbox-fixtures.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import FailedCreateActions from '../ui/FailedCreateActions.tsx';

let items: OutboxItem[] = [];
const subs = new Set<() => void>();
let status = { remindRecs: new Set<string>(), retryRecs: new Set<string>() };
const outbox = {
  subscribe(fn: () => void) {
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  },
  getStatus: () => status as never,
  list: async () => items,
};
const setItems = (next: OutboxItem[]): void => {
  items = next;
  status = { remindRecs: new Set(next.map((i) => i.rec)), retryRecs: new Set<string>() };
  for (const f of [...subs]) f();
};
let gate: Promise<void> = Promise.resolve();
const resolve = vi.fn(async (_t: string, _id: string, _m: 'copy' | 'drop') => {
  await gate;
  return { ok: true as const, done: 'dropped' as const, id: null };
});

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  resolve.mockClear();
  gate = Promise.resolve();
  setItems([]);
});
afterEach(cleanup);

const failedInsert = (seq: number, n: number, error: string): OutboxItem => mk({ seq, id: uid(n), op: 'insert', state: 'failed', error });

describe('新建失败的两个按钮（R-378）', () => {
  it('只有不能重试的新建失败才出；能重试的、失败的 patch 不出', async () => {
    setItems([failedInsert(1, 1, 'http_400'), mk({ seq: 2, id: uid(2), state: 'failed', error: 'insert_conflict' })]);
    render(<FailedCreateActions outbox={outbox} resolve={resolve} />);
    await act(async () => undefined);
    expect(screen.queryByTestId('remind-unsynced-copy')).toBeNull();
    act(() => setItems([failedInsert(1, 1, 'insert_conflict')]));
    expect((await screen.findByTestId('remind-unsynced-copy')).textContent).toBe('另存为新的一条');
    expect((screen.getByTestId('remind-unsynced-drop')).textContent).toBe('放弃');
  });

  it('点“另存为新的一条”：每条记录各调一次；进行中再点不重复；点“放弃”按 drop 调', async () => {
    setItems([failedInsert(1, 1, 'insert_conflict'), mk({ seq: 2, id: uid(1), op: 'patch' }), failedInsert(3, 3, '23505')]);
    let open: () => void = () => undefined;
    gate = new Promise((r) => (open = r));
    render(<FailedCreateActions outbox={outbox} resolve={resolve} />);
    const copy = await screen.findByTestId('remind-unsynced-copy');
    fireEvent.click(copy);
    fireEvent.click(copy);
    expect(copy.getAttribute('aria-disabled')).toBe('true');
    open();
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    expect(resolve.mock.calls.map((c) => [c[1], c[2]])).toEqual([[uid(1), 'copy'], [uid(3), 'copy']]);
    await waitFor(() => expect(copy.getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(screen.getByTestId('remind-unsynced-drop'));
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(4));
    expect(resolve.mock.calls[2]?.[2]).toBe('drop');
  });

  it('全是 settings 的新建失败：只出“放弃”，不出“另存”；混着别的记录时两个都出（R-378 复查必改）', async () => {
    setItems([mk({ seq: 1, table: 'settings', id: uid(1), op: 'insert', state: 'failed', error: '23505' })]);
    render(<FailedCreateActions outbox={outbox} resolve={resolve} />);
    expect((await screen.findByTestId('remind-unsynced-drop')).textContent).toBe('放弃');
    expect(screen.queryByTestId('remind-unsynced-copy')).toBeNull();
    act(() => setItems([...items, failedInsert(2, 2, 'insert_conflict')]));
    expect(await screen.findByTestId('remind-unsynced-copy')).toBeTruthy();
  });

  it('真队列：重开页面后才被拒的 settings 新建（23505，没有 ai-settings 监听）只出“放弃”，点了以后从“未同步”里消失（R-378 复查必改）', async () => {
    clearAllCollections();
    const { cache, outbox: real } = await setup();
    const SID = uid(7);
    await real.enqueue({ table: 'settings', id: SID, op: 'insert', data: { id: SID, key: 'ai.model', value: 'x' } });
    const ins = await real.next();
    await real.fail(ins?.op_id ?? '', { status: 409, code: '23505', sid: null });
    expect(real.getStatus().remindRecs).toEqual(new Set([`settings:${SID}`]));
    const ctx = outboxCtx.get(real);
    if (!ctx) throw new Error('outboxCtx');
    const viaCore = vi.fn(async (t: string, id: string, m: 'copy' | 'drop') => ({ ok: true as const, ...(await resolveFailedCreateImpl(ctx, t, id, m, uid(50))) }));
    render(<FailedCreateActions outbox={real} resolve={viaCore} />);
    fireEvent.click(await screen.findByTestId('remind-unsynced-drop'));
    expect(screen.queryByTestId('remind-unsynced-copy')).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('remind-unsynced-drop')).toBeNull());
    expect(viaCore.mock.calls).toEqual([['settings', SID, 'drop']]);
    expect(await real.list()).toEqual([]);
    expect(real.getStatus().remindRecs.size).toBe(0);
    expect(await cache.getRow('settings', SID)).toBeUndefined();
  });

  it('没处理成给一句话：有依赖它的 → 只能放弃；别的原因 → 稍后再试；再点时先清掉', async () => {
    setItems([failedInsert(1, 1, 'insert_conflict')]);
    resolve.mockResolvedValueOnce({ ok: false, reason: 'rejected', code: 'has_dependents' } as never);
    render(<FailedCreateActions outbox={outbox} resolve={resolve} />);
    const msg = (): string => screen.getByTestId('remind-unsynced-failed').textContent ?? '';
    fireEvent.click(await screen.findByTestId('remind-unsynced-copy'));
    await waitFor(() => expect(msg()).toBe('有别的记录用到它，不能另存，只能放弃'));
    resolve.mockResolvedValueOnce({ ok: false, reason: 'local_unavailable' } as never);
    fireEvent.click(screen.getByTestId('remind-unsynced-drop'));
    await waitFor(() => expect(msg()).toBe('没处理成，请稍后再试'));
    fireEvent.click(screen.getByTestId('remind-unsynced-drop'));
    await waitFor(() => expect(msg()).toBe(''));
  });

  it('韩文', async () => {
    uiStore.getState().setLocale('ko-KR');
    setItems([failedInsert(1, 1, 'insert_conflict')]);
    render(<FailedCreateActions outbox={outbox} resolve={resolve} />);
    expect((await screen.findByTestId('remind-unsynced-copy')).textContent).toBe('새 항목으로 저장');
    expect((screen.getByTestId('remind-unsynced-drop')).textContent).toBe('버리기');
    resolve.mockResolvedValueOnce({ ok: false, reason: 'rejected', code: 'has_dependents' } as never);
    fireEvent.click(screen.getByTestId('remind-unsynced-copy'));
    await waitFor(() => expect(screen.getByTestId('remind-unsynced-failed').textContent).toBe('다른 항목이 이 항목을 쓰고 있어 새로 저장할 수 없어요. 버리기만 할 수 있어요'));
  });
});
