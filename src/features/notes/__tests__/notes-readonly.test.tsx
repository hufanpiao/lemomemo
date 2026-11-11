// TC-B4-09（B4 S12；R-148；架构 0.27 第 1 点）：带认不出的枚举值的随手记只读显示、写入入口统一拦下、同一条提示条
// • 页面这一层的用例按宽容读取（core/read/lenient.ts）交给 outbox.applyServer 的格式 {row, ro: true} 灌进本机库；
//   文件末尾“端到端”那组从服务器原始行走 ingestServerRows：notes 的 category_source、source 和 categories 的 created_by
//   已登记成枚举（架构 0.57，shared/schema/rows-read.ts，SCHEMA_V 3），新版本的值让这一条只读；ai_status 是系统列，新值不锁
// • 列表（瀑布流、列表两种）：正文下面单独一行标“要新版本”（不挤底行和摘要行，视觉验收 11-11），菜单里的“删除”变淡；点开、删除都拦下（不进编辑器、不开抽屉、不写、不进 outbox），
//   出“这条要新版本才能修改 · 更新”；页面自己的提示条和它同时只出一条
// • 编辑页（直接打开地址）：标题、正文、分类禁用，“⋯”灰掉，写“这条要新版本才能修改”，有“更新”；插图的“图片”“拍照”、没传上的图上的“删除”“重新插入”也禁用，
//   硬塞一张图进来上传器也拦下（回 readonly，不写行）
// • 左滑删除、多选：页面上还没有这两个入口，等入口做出来再补（主持人 11-11 定，记进任务单）
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { coldStart, getBoot, resetBootForTest } from '../../../core/boot.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import type { ServerRow } from '../../../core/cache.ts';
import { ingestServerRows } from '../../../core/read/ingest.ts';
import { readRows } from '../../../core/read/lenient.ts';
import { clearAllCollections } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { resetUploaderForTest } from '../data/image-uploader.ts';
import { resetImageViewForTest } from '../data/image-view.ts';
import NotesPage from '../ui/NotesPage.tsx';
import { serverImage, wire } from './note-images-kit.tsx';

const NOW = msAt('2026-11-10', 20 * 60, 'Asia/Seoul');
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RO = uid(1);
const OK = uid(2);

const raw = (n: number, over: Record<string, unknown> = {}) => ({
  id: uid(n), title: null, body: `第${n}条`, is_private: false, category_id: null, category_source: 'none', category_seen: true, ai_status: 'done',
  tags: [], converted_to: null, source: 'page', raw_text: '', batch_id: null, deleted_at: null, undone: false,
  created_at: msAt('2026-11-10', 9 * 60 + n, 'Asia/Seoul'), updated_at: 1, rev: 2, user_id: 'A', synced_at: '2026-11-10T00:00:00Z', ...over,
});

async function boot(view?: 'list') {
  const { factory } = fakeIndexedDB();
  const b = await coldStart({
    userId: 'A', appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
  b.profile = { ...(b.profile ?? {}), current_tz: 'Asia/Seoul' } as NonNullable<typeof b.profile>;
  // 第 1 条只读（宽容读取认不出它的值时就是这样交给 applyServer 的），第 2 条正常
  await act(async () => {
    await b.outbox?.applyServer('notes', [{ row: raw(1) as ServerRow, ro: true }, { row: raw(2) as ServerRow }]);
    if (view) {
      const s = { id: uid(900), key: 'notes.view@mobile', value: view, deleted_at: null, undone: false, rev: 1 } as ServerRow;
      await b.outbox?.applyServer('settings', [{ row: s }]);
    }
  });
  return b;
}

function open(hash = '#/notes') {
  window.history.replaceState(null, '', `/app/${hash}`);
  return render(<NotesPage />);
}

const roToast = () => screen.queryByTestId('notes-ro-toast');

beforeEach(() => {
  clearAllCollections();
  uiStore.getState().setLocale('zh-CN');
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetUploaderForTest();
  resetImageViewForTest();
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('列表：只读标记，点开、删除统一拦下（TC-B4-09）', () => {
  for (const view of ['masonry', 'list'] as const) {
    it(`${view === 'list' ? '列表' : '瀑布流'}：只读那条标“要新版本”（读屏读整句），正常那条不标；点开不进编辑器、出提示条`, async () => {
      // 列表视图按设备类型记（notes.view@mobile）：模拟成手机
      if (view === 'list') vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)', media: q, addEventListener() {}, removeEventListener() {} }));
      await boot(view === 'list' ? 'list' : undefined);
      open();
      const mark = await screen.findByTestId(`notes-ro-${RO}`);
      expect(mark.textContent).toContain('要新版本');
      expect(mark.textContent).toContain('要更新到新版本才能修改');
      expect(screen.queryByTestId(`notes-ro-${OK}`)).toBeNull();
      const host = screen.getByTestId(view === 'list' ? `notes-row-${RO}` : `notes-card-${RO}`);
      fireEvent.click(host.querySelector('button') as HTMLElement);
      expect(window.location.hash).toBe('#/notes');
      expect(roToast()?.textContent).toContain('这条要新版本才能修改');
      expect(roToast()?.textContent).toContain('更新');
    });
  }

  it('正常那条照常点开进编辑器', async () => {
    await boot();
    open();
    fireEvent.click((await screen.findByTestId(`notes-card-${OK}`)).querySelector('button') as HTMLElement);
    await waitFor(() => expect(window.location.hash).toBe(`#/note/${OK}`));
    expect(roToast()).toBeNull();
  });

  it('“⋯”里的删除变淡；点了不写、不进 outbox、行还在，出同一条提示条', async () => {
    const b = await boot();
    open();
    // 事先拦下（不等写进去被拒）：连入队都不试
    const enqueue = vi.spyOn(b.outbox as NonNullable<typeof b.outbox>, 'enqueue');
    fireEvent.click(await screen.findByTestId(`notes-more-${RO}`));
    const del = await screen.findByTestId(`notes-del-${RO}`);
    expect(del.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(del);
    await waitFor(() => expect(roToast()?.textContent).toContain('这条要新版本才能修改'));
    expect(screen.queryByTestId('notes-toast')).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
    expect(await b.outbox?.list()).toEqual([]);
    expect(screen.getByTestId(`notes-card-${RO}`)).toBeTruthy();
    expect((await b.cache?.getRow('notes', RO))?.view?.['deleted_at']).toBeNull();
  });

  it('正常那条的删除不变淡，删了出撤销条；之后再点只读那条，撤销条收起、换成只读提示条（同时只出一条）', async () => {
    await boot();
    open();
    fireEvent.click(await screen.findByTestId(`notes-more-${OK}`));
    const del = await screen.findByTestId(`notes-del-${OK}`);
    expect(del.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(del);
    await screen.findByTestId('notes-toast');
    fireEvent.click(screen.getByTestId(`notes-card-${RO}`).querySelector('button') as HTMLElement);
    await waitFor(() => expect(screen.queryByTestId('notes-toast')).toBeNull());
    expect(roToast()).toBeTruthy();
    // 再出页面自己的提示条（插图提示：选了一张 HEIC，打不开）：只读提示条收起
    const heic = new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99])], 'IMG_1.HEIC', { type: 'image/heic' });
    fireEvent.change(screen.getByTestId('notes-img-input'), { target: { files: [heic] } });
    await waitFor(() => expect(roToast()).toBeNull());
    expect(screen.getByTestId('notes-img-tip')).toBeTruthy();
  });

  it('电脑（有侧栏）：点只读那条不开抽屉，出提示条', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(width >= 900px)', media: q, addEventListener() {}, removeEventListener() {} }));
    await boot();
    open();
    fireEvent.click((await screen.findByTestId(`notes-card-${RO}`)).querySelector('button') as HTMLElement);
    expect(screen.queryByTestId('note-edit')).toBeNull();
    expect(roToast()).toBeTruthy();
  });
});

describe('编辑页：直接打开只读那条的地址', () => {
  it('标题、正文、分类禁用，“⋯”灰掉，写“这条要新版本才能修改”，有“更新”', async () => {
    await boot();
    open(`#/note/${RO}`);
    const ro = await screen.findByTestId('note-edit-ro');
    expect(ro.textContent).toContain('这条要新版本才能修改');
    expect(screen.getByTestId('edit-status').textContent).toBe('');   // 不在状态行重复，也不写“改了就自动保存”
    expect(screen.getByTestId('note-edit-update').textContent).toBe('更新');
    expect(screen.getByTestId('note-edit-more').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('note-edit-category').hasAttribute('disabled')).toBe(true);
    for (const id of ['note-edit-title', 'note-edit-body']) {
      const el = screen.getByTestId(id) as HTMLTextAreaElement | HTMLInputElement;
      expect(el.disabled || el.readOnly).toBe(true);
    }
  });

  it('插图入口也拦下：“图片”“拍照”禁用；没传上的图“删除”“重新插入”也禁用；硬塞一张进来不写、提示要新版本（代码审 M1）', async () => {
    wire({ missing: true });
    const b = await boot();
    const IMG = uid(70);
    await act(async () => {
      await b.outbox?.applyServer('note_images', [{ row: serverImage(IMG, RO) }]);
    });
    open(`#/note/${RO}`);
    await screen.findByTestId('note-edit-ro');
    for (const id of ['note-edit-img', 'note-edit-camera']) expect(screen.getByTestId(id).hasAttribute('disabled')).toBe(true);
    await waitFor(() => expect(screen.getByTestId(`note-image-${IMG}`).getAttribute('data-state')).toBe('failed'));
    for (const k of ['delete', 'reinsert']) expect(screen.getByTestId(`note-image-${k}-${IMG}`).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByTestId('note-edit-img-input'), { target: { files: [new File([new Uint8Array(5)], 'a.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect(screen.getByTestId('note-edit-img-msg').textContent).toContain('这条要新版本才能修改'));
    expect(await b.outbox?.list()).toEqual([]);
  });

  it('只读提示是中性灰条：“更新”是最右边的文字按钮（不是红底的 FormButton）；分类胶囊变淡', async () => {
    await boot();
    open(`#/note/${RO}`);
    const ro = await screen.findByTestId('note-edit-ro');
    expect(ro.lastElementChild).toBe(screen.getByTestId('note-edit-update'));
    expect(screen.getByTestId('note-edit-update').tagName).toBe('BUTTON');
    expect(screen.getByTestId('note-edit-chip').hasAttribute('data-muted')).toBe(true);
  });

  it('AI 分的、还没看过的只读那条：打开不写 category_seen（正常那条照写）', async () => {
    const b = await boot();
    const ai = { category_source: 'ai', category_seen: false };
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: raw(3, ai) as ServerRow, ro: true }, { row: raw(4, ai) as ServerRow }]);
    });
    const r = open(`#/note/${uid(3)}`);
    await screen.findByTestId('note-edit-ro');
    await act(async () => new Promise((ok) => setTimeout(ok, 50)));
    expect(await b.outbox?.list()).toEqual([]);
    r.unmount();
    open(`#/note/${uid(4)}`);
    await waitFor(async () => expect((await b.outbox?.list())?.map((i) => [i.id, i.data['category_seen']])).toEqual([[uid(4), true]]));
  });

  it('正常那条照常能改、没有“更新”', async () => {
    await boot();
    open(`#/note/${OK}`);
    await screen.findByTestId('edit-status');
    expect(screen.queryByTestId('note-edit-update')).toBeNull();
    expect(screen.getByTestId('note-edit-more').hasAttribute('disabled')).toBe(false);
  });
});

describe('韩文', () => {
  it('提示条和编辑页的“更新”', async () => {
    uiStore.getState().setLocale('ko-KR');
    await boot();
    open(`#/note/${RO}`);
    expect((await screen.findByTestId('note-edit-update')).textContent).toBe('업데이트');
  });
});

describe('端到端：服务器原始行 → 宽容读取 → 页面只读（架构 0.57）', () => {
  it('category_source 是新版本的值：这一条标只读，页面上标“要新版本”、点开被拦；source 同样；ai_status 新值不锁', async () => {
    const b = await boot();
    const deps = { cache: b.cache as NonNullable<typeof b.cache>, outbox: b.outbox as NonNullable<typeof b.outbox> };
    let ro: readonly string[] = [];
    await act(async () => {
      ro = (await ingestServerRows(deps, 'notes', [
        raw(5, { category_source: 'from_future_version' }),
        raw(6, { source: 'watch' }),
        raw(7, { ai_status: 'brand_new_status' }),
      ])).readonlyIds;
    });
    expect([...ro].sort()).toEqual([uid(5), uid(6)]);
    open();
    expect(await screen.findByTestId(`notes-ro-${uid(5)}`)).toBeTruthy();
    expect(screen.getByTestId(`notes-ro-${uid(6)}`)).toBeTruthy();
    expect(screen.queryByTestId(`notes-ro-${uid(7)}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`notes-card-${uid(5)}`).querySelector('button') as HTMLElement);
    expect(window.location.hash).toBe('#/notes');
    expect(roToast()?.textContent).toContain('这条要新版本才能修改');
  });

  it('认识的值照常：四种 category_source、四种 source 都不标只读；categories 的 created_by 不认识就只读', () => {
    const known = ['ai', 'rule', 'manual', 'none'].map((v, i) => raw(10 + i, { category_source: v, source: ['page', 'chat', 'voice', 'import'][i] }));
    expect(readRows('notes', known).readonlyIds).toEqual([]);
    const cat = (n: number, created_by: string) => ({ id: uid(n), name: '分类', color: 'p1', sort: 1, created_by, merged_into: null, deleted_at: null, undone: false, created_at: 1, updated_at: 1, rev: 1, user_id: 'A', synced_at: '2026-11-10T00:00:00Z' });
    expect(readRows('categories', [cat(20, 'ai'), cat(21, 'user'), cat(22, 'team')]).readonlyIds).toEqual([uid(22)]);
  });
});
