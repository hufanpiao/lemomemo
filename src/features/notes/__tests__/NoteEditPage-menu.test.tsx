// 随手记编辑页“⋯”菜单补齐（负责人 11-20 拍板，全 app 改善报告第六节第 4 条）：和列表页同一份 MoreMenu、同一套转换流程
// • 项和列表页一样：转成待办 / 转成日程 / 移到隐私记 / 删除（顺序同列表页）
// • 转成待办（不带图）：写出一条待办、原条进“最近删除”，提示行出列表页同一句
// • 带插图的：先弹列表页同一张确认窗，确认后原条留着、提示行出“这条随手记留着”
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { collection } from '../../../core/store.ts';
import { boot, NOW, open, serverImage, serverNote, setupImageTests, uid, wire, type Row } from './note-images-kit.tsx';

setupImageTests();

const rows = (t: string) => collection<Row>(t).getSnapshot();

async function openMenu() {
  const more = await screen.findByTestId('note-edit-more');
  await waitFor(() => expect((more as HTMLButtonElement).disabled).toBe(false));
  await act(async () => {
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false });
    fireEvent.click(more);
  });
  return screen.findByTestId('note-edit-del');
}

describe('编辑页“⋯”菜单', () => {
  it('项和列表页一样：转成待办、转成日程、移到隐私记、删除', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }]);
    });
    wire();
    open(`#/note/${uid(1)}`);
    await openMenu();
    const items = ['note-edit-to-todo', 'note-edit-to-event', 'note-edit-to-vault', 'note-edit-del'].map((t) => screen.getByTestId(t));
    expect(items.map((el) => el.textContent)).toEqual(['转成待办', '转成日程', '移到隐私记', '删除']);
    // 普通随手记没有“移出隐私记”
    expect(screen.queryByTestId('note-edit-from-vault')).toBeNull();
  });

  it('转成待办（不带图）：写出一条待办、原条进“最近删除”，提示行出列表页同一句', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }]);
    });
    wire();
    open(`#/note/${uid(1)}`);
    await openMenu();
    await act(async () => {
      fireEvent.click(screen.getByTestId('note-edit-to-todo'));
    });
    await waitFor(() => expect(rows('todos')).toHaveLength(1));
    expect(rows('todos')[0]?.['from_note_id']).toBe(uid(1));
    await waitFor(() => expect(rows('notes').find((r) => r.id === uid(1))?.['deleted_at']).toBe(NOW));
    expect((await screen.findByTestId('note-edit-conv')).textContent).toBe('已转成待办，原来这条进了“最近删除”');
  });

  it('带插图的转成日程：先弹列表页同一张确认窗；确认后原条留着，提示行出“这条随手记留着”', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }]);
      await b.outbox?.applyServer('note_images', [{ row: serverImage(uid(601), uid(1)) }]);
    });
    wire();
    open(`#/note/${uid(1)}`);
    await openMenu();
    await act(async () => {
      fireEvent.click(screen.getByTestId('note-edit-to-event'));
    });
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('转成日程')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dlg).getByRole('button', { name: /转成/ }));
    });
    await waitFor(() => expect(rows('events')).toHaveLength(1));
    expect(rows('notes').find((r) => r.id === uid(1))?.['deleted_at'] ?? null).toBeNull();
    expect((await screen.findByTestId('note-edit-conv')).textContent).toBe('已转成日程，这条随手记留着');
  });
});
