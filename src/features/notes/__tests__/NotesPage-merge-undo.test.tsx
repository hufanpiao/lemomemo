// 合并分类后的 8 秒撤销条（R-415 ③ 后半）：和删除同一个 kit UndoToast（8 秒、同一个位置），点“撤销”给被合并的分类写回 merged_into: null（经 outbox）。
// 运行日志只记结果码：notes merge undo ok / 没写成的原因 / threw <错误名>
// 用真实冷启动（假 IndexedDB），插图显示层、上传器换成桩（note-images-kit.tsx）
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerRow } from '../../../core/cache.ts';
import { collection } from '../../../core/store.ts';
import { write } from '../../../core/write.ts';
import { UNDO_TOAST_MS } from '../../../kit/components/UndoToast.tsx';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import { undoMerge } from '../data/category-merge-store.ts';
import { isUndo, useNotesToast } from '../hooks/useNotesToast.ts';
import { boot, open, serverNote, setupImageTests, uid, wire, type Row } from './note-images-kit.tsx';

setupImageTests();

const READ = uid(601);
const LIST = uid(602);
const serverCat = (id: string, name: string, sort: number): ServerRow =>
  ({ id, name, color: null, sort, created_by: 'ai', merged_into: null, deleted_at: null, undone: false, rev: 1 }) as ServerRow;
const serverSetting = (id: string, key: string, value: unknown): ServerRow => ({ id, key, value, deleted_at: null, undone: false, rev: 1 }) as ServerRow;
const rows = (t: string) => collection<Row>(t).getSnapshot();
const merged = () => rows('categories').find((c) => c.id === LIST)?.['merged_into'];

let lines: string[] = [];
function logTo() {
  lines = [];
  (globalThis as Record<string, unknown>)[RL_SLOT] = { q: [], sink: (l: string) => lines.push(l) };
}
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[RL_SLOT];
});

/** “读书 / 书单”AI 判过像，点“合并”，等撤销条出来 */
async function mergeNow() {
  const b = await boot();
  await act(async () => {
    await b.outbox?.applyServer('categories', [{ row: serverCat(READ, '读书', 1) }, { row: serverCat(LIST, '书单', 2) }]);
    await b.outbox?.applyServer('notes', [{ row: { ...serverNote(1), category_id: LIST } as ServerRow }]);
    await b.outbox?.applyServer('settings', [{ row: serverSetting(uid(900), 'notes.merge_suggest', [[READ, LIST]]) }]);
  });
  wire();
  open();
  logTo();
  await act(async () => {
    fireEvent.click(await screen.findByTestId('notes-merge-go'));
  });
  await waitFor(() => expect(merged()).toBe(READ));
  return { b, toast: await screen.findByTestId('notes-merge-toast') };
}

describe('合并分类的撤销条（R-415 ③）', () => {
  it('合并成了：底部出“已合并 · 撤销”（和删除同一个撤销条，带 data-undo-toast），输入行让上去', async () => {
    const { toast } = await mergeNow();
    expect(toast.hasAttribute('data-undo-toast')).toBe(true);
    expect(toast.textContent).toBe('已合并撤销');
    expect(within(toast).getByTestId('notes-merge-toast-undo').textContent).toBe('撤销');
    expect(screen.queryByTestId('notes-error')).toBeNull();
    expect(screen.getByTestId('notes-input-row').parentElement?.className).toMatch(/dockUp/);
    expect(lines).toEqual(['notes merge category ok']);
  });

  it('点“撤销”：给被合并的“书单”写回 merged_into: null（经 outbox），条目归回“书单”，撤销条收起；日志 notes merge undo ok', async () => {
    const { b } = await mergeNow();
    await act(async () => {
      fireEvent.click(screen.getByTestId('notes-merge-toast-undo'));
    });
    await waitFor(() => expect(merged()).toBeNull());
    expect(rows('categories').find((c) => c.id === READ)?.['merged_into']).toBeNull();
    // 合并那一笔还没发出去：outbox 把同一行的两笔 patch 并成一笔，净结果 merged_into: null
    const q = (await b.outbox?.list()) ?? [];
    expect(q.map((i) => [i.op, i.table, i.id, i.data])).toEqual([['patch', 'categories', LIST, { merged_into: null }]]);
    expect(screen.queryByTestId('notes-merge-toast')).toBeNull();
    await waitFor(() => expect(screen.getByTestId(`notes-card-${uid(1)}`).textContent).toContain('书单'));
    expect(lines).toEqual(['notes merge category ok', 'notes merge undo ok']);
  });

  it('撤销没写进本机（写入口回 ok:false）：出错条，分类还是合并着；日志只记原因', async () => {
    await mergeNow();
    const spy = vi.spyOn(write, 'patch').mockResolvedValueOnce({ ok: false, reason: 'local_unavailable' });
    await act(async () => {
      fireEvent.click(screen.getByTestId('notes-merge-toast-undo'));
    });
    expect((await screen.findByTestId('notes-error')).textContent).toBeTruthy();
    expect(merged()).toBe(READ);
    expect(lines).toEqual(['notes merge category ok', 'notes merge undo local_unavailable']);
    spy.mockRestore();
  });

  it('撤销时写库抛异常：接住、出错条，日志只记错误名，没有没人接的 Promise 拒绝', async () => {
    await mergeNow();
    const spy = vi.spyOn(write, 'patch').mockRejectedValueOnce(new TypeError('boom'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('notes-merge-toast-undo'));
    });
    expect((await screen.findByTestId('notes-error')).textContent).toBeTruthy();
    expect(lines).toEqual(['notes merge category ok', 'notes merge undo threw TypeError']);
    spy.mockRestore();
  });

  it('undoMerge 只写一笔 {merged_into: null}，结果换成列表页的 ActionResult', async () => {
    logTo();
    const patch = vi.fn().mockResolvedValueOnce({ ok: true, item: null }).mockResolvedValueOnce({ ok: false, reason: 'switching' });
    expect(await undoMerge(LIST, { w: { patch } })).toBe('ok');
    expect(await undoMerge(LIST, { w: { patch } })).toBe('silent');
    expect(patch.mock.calls).toEqual([['categories', LIST, { merged_into: null }], ['categories', LIST, { merged_into: null }]]);
    expect(lines).toEqual(['notes merge undo ok', 'notes merge undo switching']);
  });
});

describe('撤销条的时长交给 kit UndoToast（8 秒），useNotesToast 不按 4 秒收', () => {
  it(`合并的撤销条（mergeUndo）和删除的（undo）一样不被 4 秒收起、输入行让上去；转换结果照旧 4 秒收；UndoToast 默认 ${UNDO_TOAST_MS} ms`, () => {
    vi.useFakeTimers();
    const g = (toast: { kind: string; id?: string; key?: string } | null) => ({ toast, toastAt: null, dismiss: vi.fn(), show: vi.fn(), block: vi.fn() });
    const merge = g({ kind: 'mergeUndo', id: LIST });
    const up = renderHook(() => useNotesToast(merge as never)).result.current;
    const conv = g({ kind: 'conv', key: 'notes.conv.left' });
    renderHook(() => useNotesToast(conv as never));
    vi.advanceTimersByTime(5000);
    expect(up).toBe(true);
    expect(merge.dismiss).not.toHaveBeenCalled();
    expect(conv.dismiss).toHaveBeenCalledTimes(1);
    expect(UNDO_TOAST_MS).toBe(8000);
    expect([isUndo({ kind: 'undo', id: 'x' }), isUndo({ kind: 'mergeUndo', id: 'x' }), isUndo({ kind: 'error' }), isUndo(null)]).toEqual([true, true, false, false]);
    vi.useRealTimers();
  });
});
