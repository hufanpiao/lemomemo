// 随手记页（B4 S1、S2；TC-B4-01 页面一半；定稿线框 s7）：默认瀑布流、页面上没有切换；按本类设备的设置换成列表；空状态；
// 底部输入行记一句（insert 不带 ai_status）、“刚记下”；“AI”小标；“⋯”删除进“最近删除”和撤销；分类胶囊筛选
// 用真实的冷启动（假 IndexedDB）：写入经 write.* 进 outbox，再从集合读回来（同待办编辑页的测试）
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { coldStart, getBoot, resetBootForTest } from '../../../core/boot.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import type { ServerRow } from '../../../core/cache.ts';
import { clearAllCollections, collection } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import NotesPage from '../ui/NotesPage.tsx';

const NOW = msAt('2026-11-10', 20 * 60, 'Asia/Seoul');
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type Row = { id: string } & Record<string, unknown>;
const notes = () => collection<Row>('notes');

async function boot() {
  const { factory } = fakeIndexedDB();
  const b = await coldStart({
    userId: 'A', appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
  b.profile = { ...(b.profile ?? {}), current_tz: 'Asia/Seoul' } as NonNullable<typeof b.profile>;
  return b;
}

const serverNote = (n: number, over: Record<string, unknown> = {}): ServerRow =>
  ({
    id: uid(n), title: null, body: `第${n}条`, is_private: false, category_id: null, category_source: 'none', category_seen: true, ai_status: 'done',
    tags: [], converted_to: null, source: 'page', raw_text: '', batch_id: null, deleted_at: null, undone: false,
    created_at: msAt('2026-11-10', 9 * 60 + n, 'Asia/Seoul'), updated_at: 1, rev: 2, ...over,
  }) as ServerRow;
const serverCat = (id: string, name: string): ServerRow => ({ id, name, color: null, sort: 0, created_by: 'ai', merged_into: null, deleted_at: null, undone: false, rev: 1 }) as ServerRow;
const serverSetting = (key: string, value: unknown): ServerRow => ({ id: uid(900), key, value, deleted_at: null, undone: false, rev: 1 }) as ServerRow;

function open() {
  window.history.replaceState(null, '', '/app/#/notes');
  return render(<NotesPage />);
}

beforeEach(() => {
  clearAllCollections();
  uiStore.getState().setLocale('zh-CN');
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('两种显示（R-78，TC-B4-01 页面一半）', () => {
  it('默认瀑布流；页面上没有“列表 / 瀑布流”切换；空状态“想到什么就记一句”', async () => {
    await boot();
    open();
    expect(screen.getByTestId('notes').getAttribute('data-view')).toBe('masonry');
    expect(screen.getByTestId('notes-empty').textContent).toBe('想到什么就记一句');
    expect(screen.queryByRole('button', { name: /列表|瀑布流/ })).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('随手记');
  });

  it('这台是电脑：notes.view@desktop = list 换成列表，按今天 / 昨天分组；只改了 @mobile 的不影响电脑', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }, { row: serverNote(2, { created_at: msAt('2026-11-09', 21 * 60, 'Asia/Seoul') }) }]);
      await b.outbox?.applyServer('settings', [{ row: serverSetting('notes.view@mobile', 'list') }]);
    });
    open();
    expect(screen.getByTestId('notes').getAttribute('data-view')).toBe('masonry');
    cleanup();
    await act(async () => {
      await b.outbox?.applyServer('settings', [{ row: { ...serverSetting('notes.view@desktop', 'list'), id: uid(901) } as ServerRow }]);
    });
    open();
    expect(screen.getByTestId('notes').getAttribute('data-view')).toBe('list');
    expect(within(screen.getByTestId('notes-g-2026-11-10')).getByRole('heading').textContent).toBe('今天');
    expect(within(screen.getByTestId('notes-g-2026-11-09')).getByRole('heading').textContent).toBe('昨天');
  });

  it('这台是手机（触屏）：读 notes.view@mobile', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)', media: q, addEventListener() {}, removeEventListener() {} }));
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }]);
      await b.outbox?.applyServer('settings', [{ row: serverSetting('notes.view@mobile', 'list') }]);
    });
    open();
    expect(screen.getByTestId('notes').getAttribute('data-view')).toBe('list');
  });
});

describe('卡片', () => {
  it('没有标题取正文第一行；AI 分的、没看过的标“AI”；分类胶囊“全部 N”和各分类，点了只看这一类', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('categories', [{ row: serverCat(uid(50), '工作灵感') }, { row: serverCat(uid(51), '购物') }]);
      await b.outbox?.applyServer('notes', [
        { row: serverNote(1, { body: 'NEOX 片尾\n配合鼓点', category_id: uid(50), category_source: 'ai', category_seen: false }) },
        { row: serverNote(2, { title: '牛奶', body: '鸡蛋', category_id: uid(51), category_source: 'manual' }) },
        { row: serverNote(3) },
      ]);
    });
    open();
    const c1 = screen.getByTestId(`notes-card-${uid(1)}`);
    expect(c1.textContent).toContain('NEOX 片尾');
    expect(c1.textContent).toContain('配合鼓点');
    expect(within(c1).getByTestId(`notes-ai-${uid(1)}`).textContent).toBe('AI');
    expect(screen.queryByTestId(`notes-ai-${uid(2)}`)).toBeNull();
    expect(screen.getByTestId('notes-filter-all').textContent).toBe('全部 3');
    fireEvent.click(screen.getByTestId(`notes-filter-${uid(51)}`));
    expect(screen.queryByTestId(`notes-card-${uid(1)}`)).toBeNull();
    expect(screen.getByTestId(`notes-card-${uid(2)}`)).toBeTruthy();
  });

  it('窄卡退路只在视觉上藏分类名：底行里分类名文字还在（读屏照念），样式里 .catName 不用 display:none', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('categories', [{ row: serverCat(uid(50), '韩国生活与签证材料整理清单') }]);
      await b.outbox?.applyServer('notes', [
        { row: serverNote(1, { category_id: uid(50), category_source: 'ai', category_seen: false }) },
        { row: serverNote(2, { category_id: uid(50), category_source: 'manual' }) },
      ]);
    });
    open();
    for (const n of [1, 2]) {
      const foot = screen.getByTestId(`notes-more-${uid(n)}`).parentElement as HTMLElement;
      expect(foot.textContent).toContain('韩国生活与签证材料整理清单');
    }
    const css = readFileSync('src/features/notes/ui/NotesPage.module.css', 'utf8');
    const rules = [...css.matchAll(/([^{}]*\.catName[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(1);
    for (const [, sel, body] of rules) expect(body, sel).not.toMatch(/display:\s*none/);
  });
});

describe('底部输入行（线框 s7）', () => {
  it('记下一句：insert 普通随手记（正文就是这句，标题空着，不带 ai_status），出现在最上面、写“刚记下”；输入框清空', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }]);
    });
    open();
    // 空着时只有“图”，打了字才出“记下”（视觉稿 .inrow、线框 COMPOSER）
    expect(screen.queryByTestId('notes-add')).toBeNull();
    expect(screen.getByTestId('notes-img')).toBeTruthy();
    fireEvent.change(screen.getByTestId('notes-input'), { target: { value: '  首尔林银杏黄了  ' } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('notes-input-row'));
    });
    await waitFor(() => expect(notes().getSnapshot()).toHaveLength(2));
    const added = notes().getSnapshot().find((r) => r.id !== uid(1));
    expect(added).toMatchObject({ title: null, body: '首尔林银杏黄了', is_private: false, source: 'page', category_source: 'none', created_at: NOW });
    const items = (await b.outbox?.list()) ?? [];
    const ins = items.find((i) => i.op === 'insert');
    expect(ins?.table).toBe('notes');
    expect(ins && 'ai_status' in ins.data).toBe(false);
    expect((screen.getByTestId('notes-input') as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(screen.getAllByTestId(/^notes-card-/)[0]?.textContent).toContain('刚记下'));
    expect(screen.getAllByTestId(/^notes-card-/)[0]?.textContent).toContain('首尔林银杏黄了');
  });

  it('空白不记', async () => {
    const b = await boot();
    open();
    fireEvent.change(screen.getByTestId('notes-input'), { target: { value: '   ' } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('notes-input-row'));
    });
    expect(notes().getSnapshot()).toHaveLength(0);
    expect((await b.outbox?.list()) ?? []).toHaveLength(0);
  });
});

describe('删除（进“最近删除”）', () => {
  it('“⋯”菜单点删除：软删（deleted_at），从页面上消失，出撤销条；点撤销恢复', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }, { row: serverNote(2) }]);
    });
    open();
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId(`notes-more-${uid(1)}`), { button: 0, ctrlKey: false });
      fireEvent.click(screen.getByTestId(`notes-more-${uid(1)}`));
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId(`notes-del-${uid(1)}`));
    });
    await waitFor(() => expect(notes().getSnapshot().find((r) => r.id === uid(1))?.['deleted_at']).toBe(NOW));
    await waitFor(() => expect(screen.queryByTestId(`notes-card-${uid(1)}`)).toBeNull());
    expect(screen.getByTestId('notes-toast').textContent).toContain('已删除');
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('notes-toast')).getByRole('button', { name: '撤销' }));
    });
    await waitFor(() => expect(notes().getSnapshot().find((r) => r.id === uid(1))?.['deleted_at']).toBeNull());
    expect(await screen.findByTestId(`notes-card-${uid(1)}`)).toBeTruthy();
  });

  it('右键（安卓长按）也打开同一个菜单', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }]);
    });
    open();
    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId(`notes-card-${uid(1)}`).firstElementChild as Element);
    });
    expect(await screen.findByTestId(`notes-del-${uid(1)}`)).toBeTruthy();
  });
});

describe('韩文', () => {
  it('标题、空状态、输入行按韩文词典', async () => {
    await boot();
    act(() => uiStore.getState().setLocale('ko-KR'));
    open();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('메모');
    expect(screen.getByTestId('notes-empty').textContent).toBe('떠오르는 걸 한 줄 적어 보세요');
    fireEvent.change(screen.getByTestId('notes-input'), { target: { value: 'x' } });
    expect(screen.getByTestId('notes-add').textContent).toBe('적기');
  });
});

describe('视觉验收 A1 补的几处', () => {
  it('“图”按钮：插图这一批不做，点了提示“插图很快上线”', async () => {
    await boot();
    open();
    await act(async () => {
      fireEvent.click(screen.getByTestId('notes-img'));
    });
    expect(screen.getByTestId('notes-soon').textContent).toBe('插图很快上线');
    expect(screen.getByTestId('notes-img').getAttribute('aria-label')).toBe('插图');
  });

  it('输入框带 NOTES_INPUT_ID（随手记页的“＋”按它聚焦，R-380）；右上角头像是设置入口', async () => {
    await boot();
    open();
    expect(screen.getByTestId('notes-input').id).toBe('notes-input'); // 和 app/tab-of.ts 的 NOTES_INPUT_ID 一致（app/__tests__/tab-of.test.ts 核两边）
    expect(screen.getByTestId('notes-settings').getAttribute('href')).toContain('#/settings');
  });

  it('分类色点：categories.color 是 p4 画 var(--p4s)，没设颜色不画点（卡片和胶囊都一样）', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('categories', [
        { row: { ...serverCat(uid(51), '工作灵感'), color: 'p4' } as ServerRow },
        { row: serverCat(uid(52), '读书') },
      ]);
      await b.outbox?.applyServer('notes', [{ row: serverNote(1, { category_id: uid(51) }) }, { row: serverNote(2, { category_id: uid(52) }) }]);
    });
    open();
    const dotIn = (el: HTMLElement) => el.querySelector('i[aria-hidden="true"]') as HTMLElement | null;
    expect(dotIn(screen.getByTestId(`notes-card-${uid(1)}`))?.style.getPropertyValue('--dot')).toBe('var(--p4s)');
    expect(dotIn(screen.getByTestId(`notes-card-${uid(2)}`))).toBeNull();
    expect(dotIn(screen.getByTestId(`notes-filter-${uid(51)}`))?.style.getPropertyValue('--dot')).toBe('var(--p4s)');
  });
});
