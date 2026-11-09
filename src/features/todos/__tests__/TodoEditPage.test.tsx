// 待办编辑页（B2 FA-2 第一段；TC-B2-01 前半、TC-B2-74 ①②、只读行、删除和撤销）
// 用真实的冷启动（假 IndexedDB）：写入经 write.* 进 outbox，再从集合读回来
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { coldStart, getBoot, resetBootForTest } from '../../../core/boot.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import type { ServerRow } from '../../../core/cache.ts';
import { clearAllCollections, collection } from '../../../core/store.ts';
import { clock } from '../../../platform/clock.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { navigate } from '../../../app/router.ts';
import TodoEditPage from '../ui/TodoEditPage.tsx';

const ID = '00000000-0000-4000-8000-0000000000a1';
const NOW = msAt('2026-11-05', 9 * 60, 'Asia/Seoul');
type Row = { id: string } & Record<string, unknown>;
const todos = () => collection<Row>('todos');

async function boot() {
  const { factory } = fakeIndexedDB();
  const b = await coldStart({
    userId: 'A', appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
  return b;
}

const serverTodo = (over: Record<string, unknown> = {}): ServerRow =>
  ({
    id: ID, title: '交报告', done: false, due: '2026-11-05', important: false, project: '', note: '', source: 'voice', raw_text: '今天五点前交报告',
    batch_id: null, from_note_id: null, from_anniv_id: null, short: '交报', short_by: 'ai', done_at: 0, remind_days: 0, remind_time: '09:00',
    due_time: null, remind_before_min: null, push_show_title: null, notified_for: null, snooze_at: null, deleted_at: null, undone: false,
    created_at: 1, updated_at: 1, rev: 3, ...over,
  }) as ServerRow;

function open(hash: string) {
  window.history.replaceState(null, '', `/app/${hash}`);
  return render(<TodoEditPage />);
}

async function commitText(testId: string, value: string) {
  const el = screen.getByTestId(testId);
  fireEvent.focus(el);
  fireEvent.change(el, { target: { value } });
  await act(async () => {
    fireEvent.blur(el);
  });
}

async function pick(testId: string, value: string) {
  await act(async () => {
    fireEvent.change(screen.getByTestId(testId), { target: { value } });
  });
}

beforeEach(() => {
  clearAllCollections();
  uiStore.getState().setLocale('zh-CN');
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('新建', () => {
  it('标题为空不写；写上标题失焦后 insert 整行，之后再改是 patch（只带变了的列）', async () => {
    const b = await boot();
    open('#/todo/new');
    expect(screen.getByTestId('edit-status').textContent).toBe('改了就自动保存');
    await commitText('todo-edit-title', '   ');
    expect(todos().getSnapshot()).toHaveLength(0);
    await commitText('todo-edit-title', '买收纳盒');
    await waitFor(() => expect(todos().getSnapshot()).toHaveLength(1));
    const row = todos().getSnapshot()[0];
    expect(row).toMatchObject({ title: '买收纳盒', due: null, source: 'page', created_at: NOW });
    expect(screen.getByTestId('edit-status').textContent).toBe('已自动保存');
    await commitText('todo-edit-title', '买两个收纳盒');
    await waitFor(() => expect(todos().getSnapshot()[0]?.['title']).toBe('买两个收纳盒'));
    const items = (await b.outbox?.list()) ?? [];
    expect(items.map((i) => i.op)).toEqual(['insert', 'patch']);
    expect(items[1]?.data).toEqual({ title: '买两个收纳盒', updated_at: NOW });
  });

  it('只选了日期、还没写标题：“写上标题才会保存”是中性灰提示，不用报错红（负责人 11-06 真机截图 6）', async () => {
    await boot();
    open('#/todo/new');
    await pick('todo-edit-due', '2026-11-06');
    const st = screen.getByTestId('edit-status');
    expect(st.textContent).toBe('写上标题才会保存');
    expect(st.className).toMatch(/\bstatus\b/);
    expect(st.className).not.toMatch(/statusBad/);
    expect(todos().getSnapshot()).toHaveLength(0);
  });

  it('新建保存后：地址换成这一条的 id（不压历史，S7），编辑器不重挂（输入框还是同一个）', async () => {
    await boot();
    open('#/todo/new');
    const before = screen.getByTestId('todo-edit-title');
    const len = window.history.length;
    await commitText('todo-edit-title', '买收纳盒');
    await waitFor(() => expect(todos().getSnapshot()).toHaveLength(1));
    const id = todos().getSnapshot()[0]?.id;
    await waitFor(() => expect(window.location.hash).toBe(`#/todo/${id}`));
    expect(window.history.length).toBe(len);
    expect(screen.getByTestId('todo-edit-title')).toBe(before);
    // 之后再改仍是同一条（patch，不再 insert）
    await commitText('todo-edit-title', '买两个收纳盒');
    await waitFor(() => expect(todos().getSnapshot()[0]?.['title']).toBe('买两个收纳盒'));
    expect(todos().getSnapshot()).toHaveLength(1);
    // N2：再点“新建”是一张空表，写的是新的一行
    await act(async () => {
      await navigate('todo', 'new');
    });
    await waitFor(() => expect((screen.getByTestId('todo-edit-title') as HTMLInputElement).value).toBe(''));
    expect(screen.getByTestId('todo-edit-title')).not.toBe(before);
    await commitText('todo-edit-title', '买胶带');
    await waitFor(() => expect(todos().getSnapshot()).toHaveLength(2));
    expect(todos().get(id ?? '')?.['title']).toBe('买两个收纳盒');
  });
});

describe('截止日期、截止时刻（TC-B2-74）', () => {
  it('① 设截止日期后才有“截止时刻”；选了时刻才出现“提前提醒”，默认 1 小时；② 清掉时刻回到“当天 / 前一天”', async () => {
    const b = await boot();
    await b.outbox?.applyServer('todos', [{ row: serverTodo({ due: null }) }]);
    open(`#/todo/${ID}`);
    expect(screen.queryByTestId('todo-edit-due-time')).toBeNull();
    expect(screen.getByText('设了截止日期才会提醒')).toBeTruthy();
    await pick('todo-edit-due', '2026-11-05');
    expect(screen.getByTestId('todo-edit-due-time')).toBeTruthy();
    expect(screen.queryByTestId('todo-edit-before')).toBeNull();
    await pick('todo-edit-due-time', '17:00');
    const sel = screen.getByTestId('todo-edit-before') as HTMLSelectElement;
    expect(sel.value).toBe('60');
    expect([...sel.options].map((o) => o.text)).toEqual(['不提醒', '准时', '10 分钟', '30 分钟', '1 小时', '2 小时', '1 天']);
    await waitFor(() => expect(todos().get(ID)).toMatchObject({ due: '2026-11-05', due_time: '17:00', remind_before_min: 60 }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('todo-edit-due-time-clear'));
    });
    expect(screen.queryByTestId('todo-edit-before')).toBeNull();
    expect(screen.getByTestId('todo-edit-days')).toBeTruthy();
    await waitFor(() => expect(todos().get(ID)).toMatchObject({ due_time: null, remind_before_min: null, remind_days: 0 }));
  });

  it('清掉截止日期：同一个 patch 里截止时刻、提前量一起清（第 136 条）；带提醒的写入标 remind', async () => {
    const b = await boot();
    await b.outbox?.applyServer('todos', [{ row: serverTodo({ due_time: '17:00', remind_before_min: 60 }) }]);
    open(`#/todo/${ID}`);
    await pick('todo-edit-before', '10');
    await waitFor(() => expect(todos().get(ID)?.['remind_before_min']).toBe(10));
    let items = (await b.outbox?.list()) ?? [];
    expect(items.at(-1)).toMatchObject({ op: 'patch', remind: true, data: { remind_before_min: 10 } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('todo-edit-due-clear'));
    });
    await waitFor(() => expect(todos().get(ID)?.['due']).toBeNull());
    items = (await b.outbox?.list()) ?? [];
    expect(items.at(-1)?.data).toMatchObject({ due: null, due_time: null, remind_before_min: null });
    await waitFor(() => expect(todos().get(ID)).toMatchObject({ due: null, due_time: null, remind_before_min: null }));
  });

  it('中文、韩文的选项都在', async () => {
    const b = await boot();
    await b.outbox?.applyServer('todos', [{ row: serverTodo({ due_time: '17:00', remind_before_min: 60 }) }]);
    uiStore.getState().setLocale('ko-KR');
    open(`#/todo/${ID}`);
    const sel = screen.getByTestId('todo-edit-before') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.text)).toEqual(['알리지 않음', '마감 시각에', '10분 전', '30분 전', '1시간 전', '2시간 전', '1일 전']);
  });
});

describe('编辑已有的', () => {
  it('改标题：AI 起的简称一起清掉；原话显示出来', async () => {
    const b = await boot();
    await b.outbox?.applyServer('todos', [{ row: serverTodo() }]);
    open(`#/todo/${ID}`);
    expect(screen.getByTestId('todo-edit-raw').textContent).toBe('今天五点前交报告');
    await commitText('todo-edit-title', '交周报');
    await waitFor(() => expect(todos().get(ID)).toMatchObject({ title: '交周报', short: null, short_by: null }));
  });

  it('“重要”是开关（B2-UI-b W5，D2 ①）：读屏念开关，点一下写 important=true；“已完成”仍是圆圈勾选', async () => {
    const b = await boot();
    await b.outbox?.applyServer('todos', [{ row: serverTodo() }]);
    open(`#/todo/${ID}`);
    const imp = screen.getByTestId('todo-edit-important');
    expect(imp.getAttribute('role')).toBe('switch');
    expect(screen.getByTestId('todo-edit-done').getAttribute('role')).toBeNull();
    await act(async () => {
      fireEvent.click(imp);
    });
    await waitFor(() => expect(todos().get(ID)).toMatchObject({ important: true }));
  });

  it('只读行（带不认识的值，0.27①“只读显示”）：一进来顶部就出“这条要新版本才能修改 · 更新”；输入全禁用、没有“删除”、不写“改了就自动保存”；改不进去', async () => {
    const b = await boot();
    await b.outbox?.applyServer('todos', [{ row: serverTodo(), ro: true }]);
    open(`#/todo/${ID}`);
    expect(screen.getByTestId('edit-notice').textContent).toContain('这条要新版本才能修改');
    expect(screen.getByTestId('todo-edit-update')).toBeTruthy();
    expect(screen.getByTestId('edit-status').textContent).toBe('');
    expect(screen.queryByTestId('todo-edit-delete')).toBeNull();
    for (const id of ['todo-edit-title', 'todo-edit-done', 'todo-edit-due', 'todo-edit-days']) {
      expect((screen.getByTestId(id) as HTMLInputElement).disabled, id).toBe(true);
    }
    // 第二轮视觉验收第 2、3 条：“已完成”不写“打勾后也能继续改”；“清掉”和“删除”一样不出
    expect(screen.getByTestId('todo-edit-done').closest('label')?.textContent).toBe('已完成');
    expect(screen.queryByTestId('todo-edit-due-clear')).toBeNull();
    // G11：禁用的输入不出占位提示（只读时空字段不该像“可以填”）
    expect(document.querySelector('#todo-project')?.getAttribute('placeholder')).toBeNull();
    expect(screen.queryByTestId('todo-edit-due-time-clear')).toBeNull();
    await commitText('todo-edit-title', '改不了');
    expect(todos().get(ID)?.['title']).toBe('交报告');
  });

  it('可写的行照旧：有“删除”、右上“改了就自动保存”、输入可用', async () => {
    const b = await boot();
    await b.outbox?.applyServer('todos', [{ row: serverTodo() }]);
    open(`#/todo/${ID}`);
    expect(screen.getByTestId('todo-edit-delete')).toBeTruthy();
    expect(screen.getByTestId('edit-status').textContent).toBe('改了就自动保存');
    expect((screen.getByTestId('todo-edit-title') as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByTestId('edit-notice')?.textContent ?? '').not.toContain('新版本');
    expect(screen.getByTestId('todo-edit-done').closest('label')?.textContent).toBe('已完成（打勾后也能继续改）');
    expect(screen.getByTestId('todo-edit-due-clear')).toBeTruthy();
    // G11：空字段有占位提示；“清掉”“删除”用项目的按钮样式（FormButton），不是浏览器原生按钮
    expect(document.querySelector('#todo-project')?.getAttribute('placeholder')).toBe('比如：工作、家里');
    expect(screen.getByTestId('todo-edit-due-clear').className).toMatch(/btn/);
    expect(screen.getByTestId('todo-edit-delete').className).toMatch(/danger/);
  });

  it('删除：软删，页内出“撤销”；撤销后回来', async () => {
    const b = await boot();
    await b.outbox?.applyServer('todos', [{ row: serverTodo() }]);
    open(`#/todo/${ID}`);
    await act(async () => {
      fireEvent.click(screen.getByTestId('todo-edit-delete'));
    });
    await waitFor(() => expect(todos().get(ID)?.['deleted_at']).toBe(NOW));
    await waitFor(() => expect(screen.getByTestId('edit-notice').textContent).toContain('已删除'));
    expect((screen.getByTestId('todo-edit-title') as HTMLInputElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId('todo-edit-undo'));
    });
    await waitFor(() => expect(todos().get(ID)?.['deleted_at']).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('edit-notice')).toBeNull());
  });

  it('找不到（地址里的 id 不在本机）：提示，控件不可用', async () => {
    await boot();
    open('#/todo/00000000-0000-4000-8000-0000000000ff');
    expect(screen.getByTestId('edit-status').textContent).toBe('找不到这一条，可能已在别的设备上删除');
    expect((screen.getByTestId('todo-edit-title') as HTMLInputElement).disabled).toBe(true);
  });

  it('本机库不能用（unavailable）：提示没存上，输入保留', async () => {
    resetBootForTest();
    open('#/todo/new');
    await commitText('todo-edit-title', '先记着');
    await waitFor(() => expect(screen.getByTestId('edit-status').textContent).toBe('这台设备现在存不了，内容还在这里，稍后再改一次'));
    expect((screen.getByTestId('todo-edit-title') as HTMLInputElement).value).toBe('先记着');
  });
});
