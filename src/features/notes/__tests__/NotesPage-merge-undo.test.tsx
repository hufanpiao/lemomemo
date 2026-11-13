// 合并分类后的 8 秒撤销条（R-415 ③ 后半）：和删除同一个 kit UndoToast（8 秒、同一个位置）。
// 点“撤销”= 点了“不用”（这一对记进 notes.merge_dismissed，负责人 11-13 定）+ 被合并的分类回到 merged_into: null：
//   合并那一笔还没发（outbox 合成一笔 null）、已经发了（另写一笔 null）、发送失败（直接丢掉它，不另写）三种都测。
// 合并、撤销写库抛异常都接住出错条；提示条写入期间两个按钮禁用（连点只算一下）。
// 运行日志：notes merge category|undo|dismiss <结果码> merge=<id> keep=<id>（合并那行带 why=ai|rule），不记分类名
// 用真实冷启动（假 IndexedDB），插图显示层、上传器换成桩（note-images-kit.tsx）；连点、计时两条把提示条换成桩（不碰 IndexedDB，好用假时钟）
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerRow } from '../../../core/cache.ts';
import { getBoot } from '../../../core/boot.ts';
import { collection } from '../../../core/store.ts';
import { write } from '../../../core/write.ts';
import { UNDO_TOAST_MS } from '../../../kit/components/UndoToast.tsx';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import { undoMerge } from '../data/category-merge-store.ts';
import type { MergeHint } from '../hooks/useMergeHint.ts';
import { isUndo, mergeUndo, undoTipOf, useNotesToast } from '../hooks/useNotesToast.ts';
import { boot, open, sendNext, serverNote, setupImageTests, uid, wire, type Row } from './note-images-kit.tsx';

/** 连点、计时两条用的桩：不为 null 时页面拿它当提示条 */
let stubHint: MergeHint | null = null;
vi.mock('../hooks/useMergeHint.ts', async (importOriginal) => {
  const m = await importOriginal<{ useMergeHint(): MergeHint | null }>();
  return {
    ...m,
    useMergeHint: () => {
      const real = m.useMergeHint();
      return stubHint ?? real;
    },
  };
});

setupImageTests();

const READ = uid(601);
const LIST = uid(602);
const PAIR = `merge=${LIST} keep=${READ}`;
const serverCat = (id: string, name: string, sort: number): ServerRow =>
  ({ id, name, color: null, sort, created_by: 'ai', merged_into: null, deleted_at: null, undone: false, rev: 1 }) as ServerRow;
const serverSetting = (id: string, key: string, value: unknown): ServerRow => ({ id, key, value, deleted_at: null, undone: false, rev: 1 }) as ServerRow;
const rows = (t: string) => collection<Row>(t).getSnapshot();
const merged = () => rows('categories').find((c) => c.id === LIST)?.['merged_into'];
const dismissed = () => rows('settings').find((r) => r['key'] === 'notes.merge_dismissed')?.['value'];
/** outbox 里分类表的项（撤销时还会有记“不用”的那一笔 settings） */
const catQueue = async () => ((await getBoot()?.outbox?.list()) ?? []).filter((i) => i.table === 'categories').map((i) => [i.op, i.id, i.data, i.state]);

let lines: string[] = [];
function logTo() {
  lines = [];
  (globalThis as Record<string, unknown>)[RL_SLOT] = { q: [], sink: (l: string) => lines.push(l) };
}
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[RL_SLOT];
  stubHint = null;
});

/** “读书 / 书单”AI 判过像，页面开着、提示条出着 */
async function setup() {
  const b = await boot();
  await act(async () => {
    await b.outbox?.applyServer('categories', [{ row: serverCat(READ, '读书', 1) }, { row: serverCat(LIST, '书单', 2) }]);
    await b.outbox?.applyServer('notes', [{ row: { ...serverNote(1), category_id: LIST } as ServerRow }]);
    await b.outbox?.applyServer('settings', [{ row: serverSetting(uid(900), 'notes.merge_suggest', [[READ, LIST]]) }]);
  });
  wire();
  open();
  logTo();
  return b;
}

/** 点“合并”，等撤销条出来 */
async function mergeNow() {
  const b = await setup();
  await act(async () => {
    fireEvent.click(await screen.findByTestId('notes-merge-go'));
  });
  await waitFor(() => expect(merged()).toBe(READ));
  return { b, toast: await screen.findByTestId('notes-merge-toast') };
}

const clickUndo = () =>
  act(async () => {
    fireEvent.click(screen.getByTestId('notes-merge-toast-undo'));
  });

/** 只拦分类表的 patch（记“不用”的 settings 照真的走） */
function catPatch(impl: () => Promise<never> | Promise<{ ok: false; reason: 'local_unavailable' }>) {
  const real = write.patch.bind(write);
  return vi.spyOn(write, 'patch').mockImplementation((table, id, data, o) => (table === 'categories' ? impl() : real(table, id, data, o)));
}

describe('合并分类的撤销条（R-415 ③）', () => {
  it('合并成了：底部出“已合并 · 撤销”（和删除同一个撤销条，带 data-undo-toast），输入行让上去；日志带 merge= keep= why=ai', async () => {
    const { toast } = await mergeNow();
    expect(toast.hasAttribute('data-undo-toast')).toBe(true);
    expect(toast.textContent).toBe('已合并撤销');
    expect(within(toast).getByTestId('notes-merge-toast-undo').textContent).toBe('撤销');
    expect(screen.queryByTestId('notes-error')).toBeNull();
    expect(screen.getByTestId('notes-input-row').parentElement?.className).toMatch(/dockUp/);
    expect(lines).toEqual([`notes merge category ok ${PAIR} why=ai`]);
  });

  it('点“撤销”（合并那一笔还没发）：这一对记进“不用”，书单回到 merged_into: null（outbox 合成一笔），条目归回“书单”；提示条不再出这一对', async () => {
    await mergeNow();
    await clickUndo();
    await waitFor(() => expect(merged()).toBeNull());
    expect(rows('categories').find((c) => c.id === READ)?.['merged_into']).toBeNull();
    expect(await catQueue()).toEqual([['patch', LIST, { merged_into: null }, 'pending']]);
    expect(dismissed()).toEqual([[READ, LIST]]);
    expect(screen.queryByTestId('notes-merge-toast')).toBeNull();
    await waitFor(() => expect(screen.getByTestId(`notes-card-${uid(1)}`).textContent).toContain('书单'));
    // 两个分类又都活着、AI 也还判它们像，但点过撤销 = 点过“不用”：提示条不再出
    expect(screen.queryByTestId('notes-merge')).toBeNull();
    expect(lines).toEqual([`notes merge category ok ${PAIR} why=ai`, `notes merge dismiss ok ${PAIR}`, `notes merge undo ok ${PAIR}`]);
  });

  it('合并那一笔已经发出去了：撤销另写一笔 {merged_into: null}', async () => {
    await mergeNow();
    await act(async () => {
      await sendNext();
    });
    expect(await catQueue()).toEqual([]);
    await clickUndo();
    await waitFor(() => expect(merged()).toBeNull());
    expect(await catQueue()).toEqual([['patch', LIST, { merged_into: null }, 'pending']]);
    expect(lines.at(-1)).toBe(`notes merge undo ok ${PAIR}`);
  });

  it('合并那一笔发送失败了（被拒的 patch 本机已显示回服务器那份 null）：撤销直接丢掉它，不另写一笔，以后“重试”不会又合并回去', async () => {
    await mergeNow();
    await act(async () => {
      await sendNext('invalid_row');
    });
    expect(await catQueue()).toEqual([['patch', LIST, { merged_into: READ }, 'failed']]);
    expect(merged()).toBeNull();
    await clickUndo();
    await waitFor(async () => expect(await catQueue()).toEqual([]));
    expect(merged()).toBeNull();
    expect(dismissed()).toEqual([[READ, LIST]]);
    expect(screen.queryByTestId('notes-error')).toBeNull();
    expect(lines.at(-1)).toBe(`notes merge undo dropped ${PAIR}`);
  });

  it('撤销没写进本机（写入口回 ok:false）：出错条，分类还是合并着；日志只记原因', async () => {
    await mergeNow();
    catPatch(() => Promise.resolve({ ok: false, reason: 'local_unavailable' }));
    await clickUndo();
    expect((await screen.findByTestId('notes-error')).textContent).toBeTruthy();
    expect(merged()).toBe(READ);
    expect(lines.at(-1)).toBe(`notes merge undo local_unavailable ${PAIR}`);
  });

  it('撤销时写库抛异常：接住、出错条，日志只记错误名，没有没人接的 Promise 拒绝', async () => {
    await mergeNow();
    catPatch(() => Promise.reject(new TypeError('boom')));
    await clickUndo();
    expect((await screen.findByTestId('notes-error')).textContent).toBeTruthy();
    expect(lines.at(-1)).toBe(`notes merge undo threw TypeError ${PAIR}`);
  });

  it('点“合并”时写库抛异常：接住、出错条、不出撤销条，日志 notes merge category threw <错误名>，没有没人接的 Promise 拒绝', async () => {
    await setup();
    catPatch(() => Promise.reject(new TypeError('boom')));
    await act(async () => {
      fireEvent.click(await screen.findByTestId('notes-merge-go'));
    });
    expect((await screen.findByTestId('notes-error')).textContent).toBeTruthy();
    expect(screen.queryByTestId('notes-merge-toast')).toBeNull();
    expect(merged()).toBeNull();
    expect(lines).toEqual([`notes merge category threw TypeError ${PAIR} why=ai`]);
    expect((screen.getByTestId('notes-merge-go') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('undoMerge（data）', () => {
  const writer = () => ({ update: vi.fn(() => Promise.resolve(true)) });
  const cats = (to: unknown) => () => [{ id: READ, merged_into: null }, { id: LIST, merged_into: to }];

  it('本机这个分类现在就是合进 keep 的：先记“不用”再写一笔 null；结果换成 ActionResult', async () => {
    logTo();
    const w = writer();
    const patch = vi.fn().mockResolvedValueOnce({ ok: true, item: null }).mockResolvedValueOnce({ ok: false, reason: 'switching' });
    const deps = { w: { patch }, categories: cats(READ), outbox: null, isReadonly: () => false };
    expect(await undoMerge({ keep: READ, merge: LIST }, w, deps)).toBe('ok');
    expect(await undoMerge({ keep: READ, merge: LIST }, w, deps)).toBe('silent');
    expect(patch.mock.calls).toEqual([['categories', LIST, { merged_into: null }], ['categories', LIST, { merged_into: null }]]);
    expect(w.update).toHaveBeenCalledTimes(2);
    expect(lines.filter((l) => l.startsWith('notes merge undo'))).toEqual([`notes merge undo ok ${PAIR}`, `notes merge undo switching ${PAIR}`]);
  });

  it('本机这个分类已经不指向 keep（别的设备改过、没了）：moved，一笔不写、不记“不用”、不提示；只读行 → readonly', async () => {
    logTo();
    const w = writer();
    const patch = vi.fn();
    expect(await undoMerge({ keep: READ, merge: LIST }, w, { w: { patch }, categories: cats(uid(7)), outbox: null })).toBe('silent');
    expect(await undoMerge({ keep: READ, merge: LIST }, w, { w: { patch }, categories: () => [], outbox: null })).toBe('silent');
    expect(await undoMerge({ keep: READ, merge: LIST }, w, { w: { patch }, categories: cats(READ), outbox: null, isReadonly: () => true })).toBe('readonly');
    expect([patch.mock.calls.length, w.update.mock.calls.length]).toEqual([0, 0]);
    expect(lines).toEqual([`notes merge undo moved ${PAIR}`, `notes merge undo moved ${PAIR}`, `notes merge undo readonly ${PAIR}`]);
  });
});

describe('提示条写入期间锁住、撤销条 8 秒（提示条换成桩）', () => {
  function hintStub() {
    let done: (r: 'ok') => void = () => undefined;
    const hint = {
      keepName: '读书',
      mergeName: '书单',
      merge: vi.fn(() => new Promise<'ok'>((r) => (done = r))),
      dismiss: vi.fn(() => Promise.resolve('ok' as const)),
      undo: vi.fn(() => Promise.resolve('ok' as const)),
    };
    stubHint = hint;
    return { hint, finish: () => done('ok') };
  }

  it('快速连点“合并”“不用”：写入期间两个按钮都禁用，只合并一次、“不用”不落到下一对上；写完放开', async () => {
    const { hint, finish } = hintStub();
    open();
    const go = screen.getByTestId('notes-merge-go') as HTMLButtonElement;
    const no = screen.getByTestId('notes-merge-no') as HTMLButtonElement;
    fireEvent.click(go);
    expect([go.disabled, no.disabled]).toEqual([true, true]);
    fireEvent.click(go);
    fireEvent.click(no);
    expect([hint.merge.mock.calls.length, hint.dismiss.mock.calls.length]).toEqual([1, 0]);
    await act(async () => {
      finish();
    });
    expect(screen.getByTestId('notes-merge-toast')).toBeTruthy();
    expect([go.disabled, no.disabled]).toEqual([false, false]);
    fireEvent.click(no);
    fireEvent.click(no);
    expect(hint.dismiss).toHaveBeenCalledTimes(1);
    await act(async () => undefined);
  });

  it(`撤销条 ${UNDO_TOAST_MS} ms：7.9 秒还在，8.1 秒收起；收起时不撤销`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { hint, finish } = hintStub();
      open();
      fireEvent.click(screen.getByTestId('notes-merge-go'));
      await act(async () => {
        finish();
      });
      expect(screen.getByTestId('notes-merge-toast')).toBeTruthy();
      act(() => vi.advanceTimersByTime(7900));
      expect(screen.queryByTestId('notes-merge-toast')).not.toBeNull();
      act(() => vi.advanceTimersByTime(200));
      expect(screen.queryByTestId('notes-merge-toast')).toBeNull();
      expect(hint.undo).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('撤销条的类型和收起（useNotesToast）', () => {
  it('合并的、删除的撤销条都不被 4 秒收起、输入行让上去；转换结果照旧 4 秒收；画的那一份统一成 UndoTip', () => {
    vi.useFakeTimers();
    const g = (toast: { kind: string; id?: string; key?: string } | null) => ({ toast, toastAt: null, dismiss: vi.fn(), show: vi.fn(), block: vi.fn() });
    const undo = vi.fn();
    const tip = mergeUndo(undo);
    const merge = g(tip);
    const up = renderHook(() => useNotesToast(merge as never)).result.current;
    const conv = g({ kind: 'conv', key: 'notes.conv.left' });
    renderHook(() => useNotesToast(conv as never));
    vi.advanceTimersByTime(5000);
    expect(up).toBe(true);
    expect(merge.dismiss).not.toHaveBeenCalled();
    expect(conv.dismiss).toHaveBeenCalledTimes(1);
    expect([isUndo({ kind: 'undo', id: 'x' }), isUndo(tip), isUndo({ kind: 'error' }), isUndo(null)]).toEqual([true, true, false, false]);
    // 删除的（kit 的 {kind: 'undo', id}）补上文案和撤销；合并的原样就是；两次合并 key 不同（重新计时）
    const del = vi.fn();
    const d = undoTipOf({ kind: 'undo', id: 'n1' }, del);
    d.undo();
    expect([d.msgKey, d.testId, del.mock.calls]).toEqual(['notes.deleted', 'notes-toast', [['n1']]]);
    expect([undoTipOf(tip, del).msgKey, undoTipOf(tip, del).testId]).toEqual(['notes.merge.done', 'notes-merge-toast']);
    expect(mergeUndo(undo).key).not.toBe(tip.key);
    vi.useRealTimers();
  });
});
