// 随手记电脑详情抽屉（视觉验收 A1；NoteDrawer.tsx）：从 NotesPage.test.tsx 拆出来（文件不超过 300 行）
// 点卡片从右边出抽屉、不换页；顶行“随手记 · 分类 · 时间”；Esc / “×”关（组字中、浮层开着时 Esc 不关）；焦点进抽屉、关上还回去；读屏名字
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { coldStart, getBoot, resetBootForTest } from '../../../core/boot.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import type { ServerRow } from '../../../core/cache.ts';
import { clearAllCollections } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import NotesPage from '../ui/NotesPage.tsx';

const NOW = msAt('2026-11-10', 20 * 60, 'Asia/Seoul');
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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


describe('电脑详情抽屉', () => {
  const wideBoot = async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(width >= 900px)', media: q, addEventListener: () => undefined, removeEventListener: () => undefined }));
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }]);
    });
    open();
    // 和真浏览器一样：点之前焦点先落到卡片按钮上
    const card = screen.getByTestId(`notes-card-${uid(1)}`).querySelector('button') as HTMLButtonElement;
    card.focus();
    await act(async () => {
      fireEvent.click(card);
    });
    const drawer = await screen.findByTestId('note-drawer');
    return { card, drawer };
  };

  it('电脑（≥ 900px）：点卡片从右边出抽屉、不换页，顶行写“随手记 · 时间”；焦点进抽屉；组字中的 Esc 不关，Esc 关后焦点回到卡片', async () => {
    const { card, drawer } = await wideBoot();
    expect(window.location.hash).toBe('#/notes');
    expect(drawer.getAttribute('aria-label')).toBe('随手记详情');
    expect(within(drawer).getByTestId('note-edit').getAttribute('aria-label')).toBeNull();
    expect(within(drawer).getByTestId('note-edit-body')).toBeTruthy();
    expect(drawer.contains(document.activeElement)).toBe(true);
    // 抽屉顶行“随手记 · 分类 · 时间”（NOTE_ED）；这条没分类，就只写“随手记 · 时间”
    expect(within(drawer).getByTestId('note-edit-meta').textContent).toBe('随手记 · 今天 09:01');
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape', isComposing: true });
      fireEvent.keyDown(window, { key: 'Escape', keyCode: 229 });
    });
    expect(screen.queryByTestId('note-drawer')).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByTestId('note-drawer')).toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it('电脑：点“×”关抽屉，焦点回到原来那张卡片', async () => {
    const { card, drawer } = await wideBoot();
    expect(drawer.contains(document.activeElement)).toBe(true);
    await act(async () => {
      fireEvent.click(within(drawer).getByTestId('note-edit-close'));
    });
    expect(screen.queryByTestId('note-drawer')).toBeNull();
    expect(document.activeElement).toBe(card);
  });

  const wideMany = async (view: 'masonry' | 'list' = 'masonry') => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(width >= 900px)', media: q, addEventListener: () => undefined, removeEventListener: () => undefined }));
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }, { row: serverNote(2) }]);
      if (view === 'list') await b.outbox?.applyServer('settings', [{ row: serverSetting('notes.view@desktop', 'list') }]);
    });
    open();
    await waitFor(() => expect(screen.getByTestId('notes').getAttribute('data-view')).toBe(view));
  };
  const btnOf = (n: number, kind = 'card') => screen.getByTestId(`notes-${kind}-${uid(n)}`).querySelector('button') as HTMLButtonElement;
  const clickOpen = async (el: HTMLElement, focus = true) => {
    if (focus) el.focus();
    await act(async () => {
      fireEvent.click(el);
    });
    await screen.findByTestId('note-drawer');
  };
  const esc = async () => {
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
  };

  it('电脑：抽屉开着换到第 2 张再关，焦点回到第 2 张（不是最早点的那张）', async () => {
    await wideMany();
    await clickOpen(btnOf(1));
    await clickOpen(btnOf(2));
    await esc();
    expect(screen.queryByTestId('note-drawer')).toBeNull();
    expect(document.activeElement).toBe(btnOf(2));
  });

  it('电脑：一直是同一条时还给原来的元素，不走兜底去找卡片按钮', async () => {
    await wideMany();
    const orig = btnOf(1);
    await clickOpen(orig);
    // 兜底选择器会先找到卡片里的第一个按钮：塞一个在最前面，走兜底就会落到它上面
    const decoy = document.createElement('button');
    screen.getByTestId(`notes-card-${uid(1)}`).prepend(decoy);
    await esc();
    expect(document.activeElement).toBe(orig);
  });

  it('电脑列表方式：原来的焦点不在卡片上时，关上后落到 notes-row- 这一行的按钮', async () => {
    await wideMany('list');
    await clickOpen(btnOf(1, 'row'), false);
    await esc();
    expect(document.activeElement).toBe(btnOf(1, 'row'));
  });

  it('电脑：抽屉里的“⋯”浮层开着时按 Esc，不关抽屉', async () => {
    await wideMany();
    await clickOpen(btnOf(1));
    const drawer = screen.getByTestId('note-drawer');
    await waitFor(() => expect((within(drawer).getByTestId('note-edit-more') as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(within(drawer).getByTestId('note-edit-more'));
    });
    await screen.findByTestId('note-edit-delete');
    await esc();
    expect(screen.queryByTestId('note-drawer')).not.toBeNull();
  });
});
