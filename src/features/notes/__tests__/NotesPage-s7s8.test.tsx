// 随手记页的合并分类提示（S7，R-413；线框 MERGE）和转成待办 / 日程（S8，R-414；线框 s7 菜单、S8-2 弹窗；负责人 11-13 定）：
// • 提示条：AI 判的（settings notes.merge_suggest）“读书 / 书单”出提示；点“合并”只写被合并分类一笔 merged_into；点“不用”记进 notes.merge_dismissed、提示条消失
// • 菜单：“转成待办 / 转成日程”在“删除”上面；不带图的直接转、原条进“最近删除”、出提示；带图的先弹确认窗（取消不写、确定后原条保留）；
//   超过 2000 字两项变淡、下面写“超过 2000 字，转不了”，点了不写；只读行拦下
// 用真实冷启动（假 IndexedDB），插图显示层、上传器换成桩（note-images-kit.tsx）
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ServerRow } from '../../../core/cache.ts';
import { OutboxRejectError } from '../../../core/outbox.ts';
import { collection } from '../../../core/store.ts';
import { write } from '../../../core/write.ts';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import { useNoteList } from '../hooks/useNoteList.ts';
import { useConvertFlow } from '../ui/NotesActions.tsx';
import { boot, NOW, open, serverImage, serverNote, setupImageTests, uid, wire, type Row } from './note-images-kit.tsx';

setupImageTests();

const READ = uid(501);
const LIST = uid(502);
const serverCat = (id: string, name: string, sort: number): ServerRow =>
  ({ id, name, color: null, sort, created_by: 'ai', merged_into: null, deleted_at: null, undone: false, rev: 1 }) as ServerRow;
const serverSetting = (id: string, key: string, value: unknown): ServerRow => ({ id, key, value, deleted_at: null, undone: false, rev: 1 }) as ServerRow;
const rows = (t: string) => collection<Row>(t).getSnapshot();

async function openMenu(id: string) {
  await act(async () => {
    fireEvent.pointerDown(screen.getByTestId(`notes-more-${id}`), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByTestId(`notes-more-${id}`));
  });
  return screen.findByTestId(`notes-del-${id}`);
}

describe('合并分类提示（S7，R-413）', () => {
  async function withSuggest() {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('categories', [{ row: serverCat(READ, '读书', 1) }, { row: serverCat(LIST, '书单', 2) }]);
      await b.outbox?.applyServer('notes', [{ row: { ...serverNote(1), category_id: LIST } as ServerRow }]);
      await b.outbox?.applyServer('settings', [{ row: serverSetting(uid(900), 'notes.merge_suggest', [[READ, LIST]]) }]);
    });
    wire();
    open();
  }

  it('本机规则不算像的“读书 / 书单”：AI 判过就出提示条，文字照线框，留 sort 小的“读书”', async () => {
    await withSuggest();
    const bar = await screen.findByTestId('notes-merge');
    expect(within(bar).getByText('“读书”和“书单”两个分类很像，合成一个吗？')).toBeTruthy();
    expect([within(bar).getByTestId('notes-merge-go').textContent, within(bar).getByTestId('notes-merge-no').textContent]).toEqual(['合并', '不用']);
  });
  it('点“合并”：只给“书单”写一笔 merged_into = 读书，条目归到“读书”，提示条消失', async () => {
    await withSuggest();
    await act(async () => {
      fireEvent.click(await screen.findByTestId('notes-merge-go'));
    });
    await waitFor(() => expect(rows('categories').find((c) => c.id === LIST)?.['merged_into']).toBe(READ));
    expect(rows('categories').find((c) => c.id === READ)?.['merged_into']).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('notes-merge')).toBeNull());
    expect(screen.getByTestId(`notes-card-${uid(1)}`).textContent).toContain('读书');
  });
  it('点“不用”：记进 notes.merge_dismissed（排好序的一对），提示条消失，分类不动', async () => {
    await withSuggest();
    await act(async () => {
      fireEvent.click(await screen.findByTestId('notes-merge-no'));
    });
    await waitFor(() => expect(screen.queryByTestId('notes-merge')).toBeNull());
    const pair = [READ, LIST].sort();
    expect(rows('settings').find((s) => s['key'] === 'notes.merge_dismissed')?.['value']).toEqual([pair]);
    expect(rows('categories').find((c) => c.id === LIST)?.['merged_into']).toBeNull();
  });
  it('点“不用”写库抛错：页面出错条，运行日志只记“notes merge dismiss fail merge= keep=”，没有没人接的 Promise 拒绝', async () => {
    await withSuggest();
    const lines: string[] = [];
    (globalThis as Record<string, unknown>)[RL_SLOT] = { q: [], sink: (l: string) => lines.push(l) };
    const spy = vi.spyOn(write, 'insert').mockRejectedValueOnce(new OutboxRejectError('invalid_row'));
    await act(async () => {
      fireEvent.click(await screen.findByTestId('notes-merge-no'));
    });
    expect((await screen.findByTestId('notes-error')).textContent).toBeTruthy();
    expect(lines.filter((l) => l.startsWith('notes merge dismiss'))).toEqual([`notes merge dismiss fail merge=${LIST} keep=${READ}`]);
    spy.mockRestore();
    delete (globalThis as Record<string, unknown>)[RL_SLOT];
  });
  it('点“不用”写不进本机（写入口回 ok:false、不抛错）：同样出错条、日志记 fail，不记成 ok', async () => {
    await withSuggest();
    const lines: string[] = [];
    (globalThis as Record<string, unknown>)[RL_SLOT] = { q: [], sink: (l: string) => lines.push(l) };
    const spy = vi.spyOn(write, 'insert').mockResolvedValueOnce({ ok: false, reason: 'local_unavailable' });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('notes-merge-no'));
    });
    expect((await screen.findByTestId('notes-error')).textContent).toBeTruthy();
    expect(lines.filter((l) => l.startsWith('notes merge dismiss'))).toEqual([`notes merge dismiss fail merge=${LIST} keep=${READ}`]);
    spy.mockRestore();
    delete (globalThis as Record<string, unknown>)[RL_SLOT];
  });
  it('分类合并绕成圈（两台设备各合并一次）：打开页面就给留下的那个写回 merged_into: null，只写一次，条目归到它', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('categories', [
        { row: { ...serverCat(READ, '读书', 1), merged_into: LIST } as ServerRow }, { row: { ...serverCat(LIST, '书单', 2), merged_into: READ } as ServerRow },
      ]);
      await b.outbox?.applyServer('notes', [{ row: { ...serverNote(1), category_id: LIST } as ServerRow }]);
    });
    wire();
    open();
    await waitFor(() => expect(rows('categories').find((c) => c.id === READ)?.['merged_into']).toBeNull());
    expect(rows('categories').find((c) => c.id === LIST)?.['merged_into']).toBe(READ);
    expect(screen.getByTestId(`notes-card-${uid(1)}`).textContent).toContain('读书');
    const q = (await b.outbox?.list()) ?? [];
    expect(q.map((i) => [i.op, i.table, i.id, i.data])).toEqual([['patch', 'categories', READ, { merged_into: null }]]);
  });
  it('没有 AI 判的、本机规则也不像：不出提示条', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('categories', [{ row: serverCat(READ, '读书', 1) }, { row: serverCat(LIST, '书单', 2) }]);
    });
    wire();
    open();
    expect(screen.queryByTestId('notes-merge')).toBeNull();
  });
});

describe('转成待办 / 日程（S8，R-414）', () => {
  it('菜单顺序：转成待办、转成日程、删除', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }]);
    });
    wire();
    open();
    await openMenu(uid(1));
    const items = [`notes-to-todo-${uid(1)}`, `notes-to-event-${uid(1)}`, `notes-del-${uid(1)}`].map((t) => screen.getByTestId(t));
    expect(items.map((x) => x.textContent)).toEqual(['转成待办', '转成日程', '删除']);
    expect((items[0] as HTMLElement).compareDocumentPosition(items[2] as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId(`notes-conv-long-${uid(1)}`)).toBeNull();
  });
  it('不带图：点“转成待办”直接转，新待办带 from_note_id，原条进“最近删除”（deleted_at），出提示', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }]);
    });
    wire();
    open();
    await openMenu(uid(1));
    await act(async () => {
      fireEvent.click(screen.getByTestId(`notes-to-todo-${uid(1)}`));
    });
    await waitFor(() => expect(rows('todos')).toHaveLength(1));
    expect(rows('todos')[0]?.['from_note_id']).toBe(uid(1));
    await waitFor(() => expect(rows('notes').find((r) => r.id === uid(1))?.['deleted_at']).toBe(NOW));
    expect((await screen.findByTestId('notes-conv-tip')).textContent).toBe('已转成待办，原来这条进了“最近删除”');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('带插图：先弹确认窗（照线框 S8-2）；取消一笔不写；确定后新日程出来、原条保留（不写 deleted_at，只记 converted_to）', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }]);
      await b.outbox?.applyServer('note_images', [{ row: serverImage(uid(601), uid(1)) }, { row: serverImage(uid(602), uid(1)) }]);
    });
    wire();
    open();
    expect(screen.queryByTestId(`notes-conv-${uid(1)}`)).toBeNull();
    await openMenu(uid(1));
    await act(async () => {
      fireEvent.click(screen.getByTestId(`notes-to-event-${uid(1)}`));
    });
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('转成日程')).toBeTruthy();
    expect(within(dlg).getByText('日程不能带图片。这条随手记会保留（不进“最近删除”），2 张图片还在原处。')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dlg).getByRole('button', { name: '取消' }));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rows('events')).toHaveLength(0);

    await openMenu(uid(1));
    await act(async () => {
      fireEvent.click(screen.getByTestId(`notes-to-todo-${uid(1)}`));
    });
    const d2 = await screen.findByRole('dialog');
    expect(within(d2).getByText('待办不能带图片。这条随手记会保留（不进“最近删除”），新的待办里有“来自随手记 ›”链回这里，2 张图片还在原处。')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(d2).getByRole('button', { name: '转成 1 条待办' }));
    });
    await waitFor(() => expect(rows('todos')).toHaveLength(1));
    const n = rows('notes').find((r) => r.id === uid(1));
    await waitFor(() => expect(rows('notes').find((r) => r.id === uid(1))?.['converted_to']).toEqual([{ kind: 'todo', id: rows('todos')[0]?.id }]));
    expect(n?.['deleted_at'] ?? null).toBeNull();
    expect(screen.getByTestId(`notes-card-${uid(1)}`)).toBeTruthy();
    expect((await screen.findByTestId('notes-conv-tip')).textContent).toBe('已转成待办，这条随手记留着');
    // R-415 ③ 方案丙：留着的原条，卡片标题前出“已转过”描边小标
    const mark = await screen.findByTestId(`notes-conv-${uid(1)}`);
    expect(mark.textContent).toBe('已转过');
    expect(mark.parentElement?.firstElementChild).toBe(mark);
    expect(mark.parentElement?.className).toMatch(/cardTitle/);
  });

  it('“已转过”（R-415 ③ 方案丙）：列表视图的标题前同样出；converted_to 为空、为 null 的不出', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [
        { row: { ...serverNote(1), converted_to: [{ kind: 'event', id: uid(700) }] } as ServerRow },
        { row: { ...serverNote(2), converted_to: [] } as ServerRow },
        { row: serverNote(3) },
      ]);
      await b.outbox?.applyServer('settings', [{ row: serverSetting(uid(900), 'notes.view@desktop', 'list') }]);
    });
    wire();
    open();
    expect(screen.getByTestId('notes').getAttribute('data-view')).toBe('list');
    const mark = await screen.findByTestId(`notes-conv-${uid(1)}`);
    expect(mark.parentElement?.className).toMatch(/t1/);
    expect(mark.parentElement?.textContent).toBe('已转过第1条');
    expect([screen.queryByTestId(`notes-conv-${uid(2)}`), screen.queryByTestId(`notes-conv-${uid(3)}`)]).toEqual([null, null]);
  });
  it('超过 2000 字：两项变淡（aria-disabled）、下面写“超过 2000 字，转不了”，点了一笔不写；“删除”照常', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: { ...serverNote(1), title: '长文', body: '字'.repeat(2001) } as ServerRow }]);
    });
    wire();
    open();
    await openMenu(uid(1));
    expect(screen.getByTestId(`notes-conv-long-${uid(1)}`).textContent).toBe('超过 2000 字，转不了');
    expect(screen.getByTestId(`notes-to-todo-${uid(1)}`).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId(`notes-to-event-${uid(1)}`).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId(`notes-del-${uid(1)}`).getAttribute('aria-disabled')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId(`notes-to-todo-${uid(1)}`));
    });
    // 不弹确认窗（菜单本身也是 role=dialog 的弹层，按确认窗的按钮查）、不写
    expect([rows('todos').length, screen.queryByRole('button', { name: /转成 1 条/ })]).toEqual([0, null]);
  });
  it('刚好 2000 字：照常能转', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: { ...serverNote(1), title: '长文', body: '字'.repeat(2000) } as ServerRow }]);
    });
    wire();
    open();
    await openMenu(uid(1));
    expect(screen.queryByTestId(`notes-conv-long-${uid(1)}`)).toBeNull();
    expect(screen.getByTestId(`notes-to-todo-${uid(1)}`).getAttribute('aria-disabled')).toBeNull();
  });
});

describe('转成待办 / 日程：带不带图只判一次（R-414）', () => {
  it('弹窗问的时候带图：确定之前图被删光，原条照样保留、提示“留着”', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }]);
      await b.outbox?.applyServer('note_images', [{ row: serverImage(uid(601), uid(1)) }]);
    });
    wire();
    open();
    await openMenu(uid(1));
    await act(async () => {
      fireEvent.click(screen.getByTestId(`notes-to-todo-${uid(1)}`));
    });
    const dlg = await screen.findByRole('dialog');
    await act(async () => {
      await b.outbox?.applyServer('note_images', [{ row: { ...serverImage(uid(601), uid(1)), deleted_at: 5, rev: 2 } as ServerRow }]);
    });
    await act(async () => {
      fireEvent.click(within(dlg).getByRole('button', { name: '转成 1 条待办' }));
    });
    await waitFor(() => expect(rows('todos')).toHaveLength(1));
    expect(rows('notes').find((r) => r.id === uid(1))?.['deleted_at'] ?? null).toBeNull();
    expect((await screen.findByTestId('notes-conv-tip')).textContent).toBe('已转成待办，这条随手记留着');
  });
  it('点的时候不带图、转换那一刻有了图：也保留原条（两者取或）', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }]);
      await b.outbox?.applyServer('note_images', [{ row: serverImage(uid(601), uid(1)) }]);
    });
    const { result } = renderHook(() => useNoteList());
    let r: Awaited<ReturnType<typeof result.current.convert>> | undefined;
    await act(async () => {
      r = await result.current.convert(uid(1), 'event', false);
    });
    expect([r?.ok, r?.kept]).toEqual([true, true]);
    expect(rows('notes').find((x) => x.id === uid(1))?.['deleted_at'] ?? null).toBeNull();
  });
  it('流程拿到 too_long 出“超过 2000 字，转不了”（现成词条）；busy 不提示也不出错条；抛异常出错条', async () => {
    const show = vi.fn();
    const report = vi.fn();
    const a = { g: { show, block: vi.fn() }, isRo: () => false, report } as unknown as Parameters<typeof useConvertFlow>[1];
    const it1 = { id: uid(1), images: 0 } as Parameters<ReturnType<typeof useConvertFlow>['start']>[0];
    for (const reason of ['too_long', 'busy'] as const) {
      const run = vi.fn(() => Promise.resolve({ ok: false as const, reason, kept: false }));
      const { result } = renderHook(() => useConvertFlow(run, a));
      await act(async () => {
        result.current.start(it1, 'todo');
        await Promise.resolve();
      });
      expect(run).toHaveBeenCalledWith(uid(1), 'todo', false);
    }
    expect(show.mock.calls).toEqual([[{ kind: 'conv', key: 'notes.conv.long' }]]);
    expect(report.mock.calls).toEqual([['silent']]);
    // 转换抛异常：兜底出错条，不留没人接的拒绝
    const boom = vi.fn(() => Promise.reject(new Error('boom')));
    const { result } = renderHook(() => useConvertFlow(boom, a));
    await act(async () => {
      result.current.start(it1, 'todo');
      await Promise.resolve();
    });
    expect(report.mock.calls).toEqual([['silent'], ['failed']]);
  });
});
