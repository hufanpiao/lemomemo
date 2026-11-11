// 随手记编辑器（B4 S2；定稿线框 s8；TC-B4-14）：新建（标题和正文都空不写；第一次 insert 整行、不带 ai_status，之后 patch）；
// 正文停笔自动存；AI 分的打开就写已看；手动改分类写 manual；删除和撤销；连续打字（第一个 patch 在途）不生成冲突副本
// 用真实的冷启动（假 IndexedDB）：写入经 write.* 进 outbox，再从集合读回来（同待办编辑页的测试）
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { coldStart, getBoot, resetBootForTest } from '../../../core/boot.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import type { ServerRow } from '../../../core/cache.ts';
import type { OutboxItem } from '../../../core/outbox.ts';
import { clearAllCollections, collection } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import NotesPage from '../ui/NotesPage.tsx';

const ID = '00000000-0000-4000-8000-0000000000b1';
const CAT1 = '00000000-0000-4000-8000-0000000000c1';
const CAT2 = '00000000-0000-4000-8000-0000000000c2';
const NOW = msAt('2026-11-10', 20 * 60, 'Asia/Seoul');
type Row = { id: string } & Record<string, unknown>;
const notes = () => collection<Row>('notes');

async function boot() {
  const { factory } = fakeIndexedDB();
  const b = await coldStart({
    userId: 'A', appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
  return b;
}

const serverNote = (over: Record<string, unknown> = {}): ServerRow =>
  ({
    id: ID, title: '首尔林银杏黄了', body: '下周末带相机', is_private: false, category_id: CAT1, category_source: 'rule', category_seen: true, ai_status: 'done',
    tags: [], converted_to: null, source: 'page', raw_text: '', batch_id: null, deleted_at: null, undone: false, created_at: 1, updated_at: 1, rev: 2, ...over,
  }) as ServerRow;
const serverCat = (id: string, name: string): ServerRow => ({ id, name, color: null, sort: 0, created_by: 'ai', merged_into: null, deleted_at: null, undone: false, rev: 1 }) as ServerRow;

async function seed(b: Awaited<ReturnType<typeof boot>>, over: Record<string, unknown> = {}) {
  await act(async () => {
    await b.outbox?.applyServer('categories', [{ row: serverCat(CAT1, '韩国生活') }, { row: serverCat(CAT2, '购物') }]);
    await b.outbox?.applyServer('notes', [{ row: serverNote(over) }]);
  });
}

function open(hash: string) {
  window.history.replaceState(null, '', `/app/${hash}`);
  return render(<NotesPage />);
}

async function typeBody(value: string, blur = true) {
  const el = screen.getByTestId('note-edit-body');
  fireEvent.focus(el);
  fireEvent.change(el, { target: { value } });
  if (blur) {
    await act(async () => {
      fireEvent.blur(el);
    });
  }
}

const patches = async (b: Awaited<ReturnType<typeof boot>>): Promise<OutboxItem[]> => ((await b.outbox?.list()) ?? []).filter((i) => i.op === 'patch');

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

describe('新建 #/note/new', () => {
  it('标题和正文都空不写；写了正文失焦后 insert 整行（不带 ai_status、没分到类写 none），地址换成这一条；再改是 patch', async () => {
    const b = await boot();
    open('#/note/new');
    expect(screen.getByTestId('edit-status').textContent).toBe('改了就自动保存');
    await typeBody('   ');
    expect(notes().getSnapshot()).toHaveLength(0);
    await typeBody('想到一句');
    // 等保存状态出来再断言（默认 1 秒的 waitFor 在高负载下会超时，代码审 a4dc5a71）
    await waitFor(() => expect(screen.getByTestId('edit-status').textContent).toBe('已自动保存'), { timeout: 5000 });
    expect(notes().getSnapshot()).toHaveLength(1);
    const row = notes().getSnapshot()[0];
    expect(row).toMatchObject({ title: null, body: '想到一句', is_private: false, category_id: null, category_source: 'none', source: 'page', created_at: NOW });
    const ins = ((await b.outbox?.list()) ?? []).find((i) => i.op === 'insert');
    expect(ins && 'ai_status' in ins.data).toBe(false);
    await waitFor(() => expect(window.location.hash).toBe(`#/note/${row?.id ?? ''}`), { timeout: 5000 });
    await typeBody('想到一句话');
    await waitFor(async () => expect((await b.outbox?.list())?.some((i) => i.data['body'] === '想到一句话')).toBe(true), { timeout: 5000 });
    expect(((await b.outbox?.list()) ?? []).filter((i) => i.op === 'insert')).toHaveLength(1);
    expect(notes().getSnapshot()).toHaveLength(1);
  });
});

describe('编辑', () => {
  it('正文停笔约 0.8 秒自己存（不用失焦）', async () => {
    const b = await boot();
    await seed(b);
    open(`#/note/${ID}`);
    await typeBody('下周末带相机，去东门', false);
    expect(await patches(b)).toHaveLength(0);
    await waitFor(async () => expect((await patches(b)).map((p) => p.data['body'])).toEqual(['下周末带相机，去东门']), { timeout: 2000 });
  });

  it('AI 分的、没看过的：分类旁标“AI”，打开就写 category_seen = true（只写一次），标记这次打开一直留着', async () => {
    const b = await boot();
    await seed(b, { category_source: 'ai', category_seen: false });
    open(`#/note/${ID}`);
    expect(screen.getByTestId('note-edit-ai').textContent).toBe('AI');
    await waitFor(async () => expect((await patches(b)).map((p) => p.data)).toEqual([{ category_seen: true, updated_at: NOW }]));
    await waitFor(() => expect(notes().getSnapshot()[0]?.['category_seen']).toBe(true));
    expect(screen.getByTestId('note-edit-ai')).toBeTruthy();
    expect(await patches(b)).toHaveLength(1);
  });

  it('看过的、规则分的不标“AI”，也不写已看', async () => {
    const b = await boot();
    await seed(b);
    open(`#/note/${ID}`);
    expect(screen.queryByTestId('note-edit-ai')).toBeNull();
    await act(async () => undefined);
    expect(await patches(b)).toHaveLength(0);
  });

  it('手动改分类：同一个 patch 写 category_id、category_source = manual、category_seen = true；“AI”标记跟着去掉', async () => {
    const b = await boot();
    await seed(b, { category_source: 'ai', category_seen: false });
    open(`#/note/${ID}`);
    await waitFor(() => expect(notes().getSnapshot()[0]?.['category_seen']).toBe(true));
    await act(async () => {
      fireEvent.change(screen.getByTestId('note-edit-category'), { target: { value: CAT2 } });
    });
    await waitFor(() => expect(notes().getSnapshot()[0]).toMatchObject({ category_id: CAT2, category_source: 'manual', category_seen: true }));
    expect(screen.queryByTestId('note-edit-ai')).toBeNull();
    // 选项：不分类 + 两个分类
    expect([...(screen.getByTestId('note-edit-category') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['不分类', '韩国生活', '购物']);
  });

  it('删除：软删、页内出“已删除”和“撤销”；撤销后恢复', async () => {
    const b = await boot();
    await seed(b);
    open(`#/note/${ID}`);
    // 删除在顶栏“⋯”里（线框 s8）
    await act(async () => {
      fireEvent.click(await screen.findByTestId('note-edit-more'));
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('note-edit-delete'));
    });
    await waitFor(() => expect(notes().getSnapshot()[0]?.['deleted_at']).toBe(NOW));
    expect(screen.getByTestId('edit-notice').textContent).toContain('已删除');
    await act(async () => {
      fireEvent.click(screen.getByTestId('note-edit-undo'));
    });
    await waitFor(() => expect(notes().getSnapshot()[0]?.['deleted_at']).toBeNull());
  });
});

describe('TC-B4-14：正文连续打字（第一个 patch 在途）不生成冲突副本', () => {
  /**
   * 服务器 apply_patch 的判法（架构 4.x，K6 M6）：base_rev 之后、除了 own_revs 以外还有人改过 title / body，才另存冲突副本。
   * 这里照这个判法看第二个 patch 发出去时带的 base_rev / own_revs
   */
  const wouldFork = (item: OutboxItem, serverRev: number, othersRevs: readonly number[]): boolean =>
    item.base_rev !== null && othersRevs.some((r) => r > (item.base_rev ?? 0) && r <= serverRev && !item.own_revs.includes(r));

  it('第一个 patch 发出去还没回来时接着打字：第二个 patch 排在后面不合并；第一个确认后它的 base_rev 推进到新 rev，服务器不判冲突', async () => {
    const b = await boot();
    await seed(b);
    open(`#/note/${ID}`);
    await typeBody('下周末带相机，去');
    await waitFor(async () => expect(await patches(b)).toHaveLength(1));
    const first = await b.outbox?.next();   // 在途
    expect(first?.base_rev).toBe(2);
    await typeBody('下周末带相机，去东门');
    await waitFor(async () => expect(await patches(b)).toHaveLength(2));
    const queued = (await patches(b)).find((p) => p.op_id !== first?.op_id);
    expect(queued?.data['body']).toBe('下周末带相机，去东门');
    // 第一个回来：rev 3，中间没人写过
    await b.outbox?.ack(first?.op_id ?? '', { status: 'ok', rev: 3, prev_rev: 2 });
    const second = await b.outbox?.next();
    expect(second?.op_id).toBe(queued?.op_id);
    expect(second?.base_rev).toBe(3);
    // rev 3 是自己写的：服务器上 rev 3 之后没人再改，第二个 patch 不判冲突
    expect(second && wouldFork(second, 3, [])).toBe(false);
  });

  it('第一个回来时中间夹了别的设备的写入（prev_rev 对不上）：自己那次 rev 进 own_revs，服务器只按别人的那次判', async () => {
    const b = await boot();
    await seed(b);
    open(`#/note/${ID}`);
    await typeBody('a');
    await waitFor(async () => expect(await patches(b)).toHaveLength(1));
    const first = await b.outbox?.next();
    await typeBody('ab');
    await waitFor(async () => expect(await patches(b)).toHaveLength(2));
    // 别的设备在 rev 3 改了 category（不碰正文），我们的第一个落在 rev 4
    await b.outbox?.ack(first?.op_id ?? '', { status: 'ok', rev: 4, prev_rev: 3 });
    const second = await b.outbox?.next();
    expect(second?.own_revs).toContain(4);
    expect(second?.base_rev).toBe(2);
    // 别人的 rev 3 照样算（它碰没碰正文由服务器按列判）；自己的 rev 4 不被当成别人改的
    expect(second && wouldFork(second, 4, [3])).toBe(true);
    expect(second && wouldFork(second, 4, [4])).toBe(false);
  });
});

describe('标题框回车和输入法组字（Q-21）', () => {
  // 标题框（DraftArea single）回车 = 失焦并存；中文、韩文输入法组字时的回车是选字，这时失焦会丢掉还没上屏的字。
  // 只断言“马上”的结果：0.8 秒的停笔计时还没到，这时能存上的只有失焦
  const typed = async (b: Awaited<ReturnType<typeof boot>>) => {
    await seed(b);
    open(`#/note/${ID}`);
    const el = screen.getByTestId('note-edit-title');
    act(() => el.focus());
    fireEvent.change(el, { target: { value: '首尔林银杏黄了 한글' } });
    return el;
  };

  it('组字中按回车（isComposing）：不失焦、不存', async () => {
    const b = await boot();
    const el = await typed(b);
    await act(async () => {
      fireEvent.keyDown(el, { key: 'Enter', isComposing: true });
    });
    expect(document.activeElement).toBe(el);
    expect(await patches(b)).toHaveLength(0);
  });

  it('Safari 选字那一下回车 keyCode 229（isComposing 为假）：同样不失焦、不存', async () => {
    const b = await boot();
    const el = await typed(b);
    await act(async () => {
      fireEvent.keyDown(el, { key: 'Enter', keyCode: 229 });
    });
    expect(document.activeElement).toBe(el);
    expect(await patches(b)).toHaveLength(0);
  });

  it('组完字再按回车（keyCode 13）：失焦并存', async () => {
    const b = await boot();
    const el = await typed(b);
    await act(async () => {
      fireEvent.keyDown(el, { key: 'Enter', keyCode: 13 });
    });
    expect(document.activeElement).not.toBe(el);
    await waitFor(async () => expect((await patches(b)).map((p) => p.data['title'])).toEqual(['首尔林银杏黄了 한글']), { timeout: 2000 });
  });
});

describe('补存：没停笔就离开也不丢字（代码审 可选 2）', () => {
  // 停笔计时用假时钟、全程不推进：800 ms 的计时器永远不会自己触发，能存上的只有补存（去掉任一处补存，对应那条就会红）。
  // 只假 setTimeout / clearTimeout，IndexedDB 照常走；不用 waitFor（它自己也靠 setTimeout），改为让出几轮 setImmediate 等写入落地
  const freeze = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
    });
  };
  afterEach(() => {
    vi.useRealTimers();
  });

  it('离开页面（pagehide）：停笔计时还没到，马上补存一次', async () => {
    const b = await boot();
    await seed(b);
    open(`#/note/${ID}`);
    freeze();
    await typeBody('改到一半就关了', false);
    await settle();
    expect(await patches(b)).toHaveLength(0);
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await settle();
    expect((await patches(b)).map((p) => p.data['body'])).toEqual(['改到一半就关了']);
  });

  it('切到后台（visibilitychange → hidden）：马上补存一次；回到前台不重复存', async () => {
    const b = await boot();
    await seed(b);
    open(`#/note/${ID}`);
    freeze();
    await typeBody('切出去回个消息', false);
    await settle();
    expect(await patches(b)).toHaveLength(0);
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    expect((await patches(b)).map((p) => p.data['body'])).toEqual(['切出去回个消息']);
    vis.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(900);
    });
    await settle();
    expect(await patches(b)).toHaveLength(1);
  });

  it('新建页没停笔就离开（编辑器卸载）：补存成一条新的随手记', async () => {
    const b = await boot();
    const r = open('#/note/new');
    freeze();
    await typeBody('新的一句还没停笔', false);
    await settle();
    expect(notes().getSnapshot()).toHaveLength(0);
    await act(async () => {
      r.unmount();
    });
    await settle();
    expect(notes().getSnapshot().map((x) => x['body'])).toEqual(['新的一句还没停笔']);
    expect(((await b.outbox?.list()) ?? []).filter((i) => i.op === 'insert')).toHaveLength(1);
  });
});

describe('已删除的不写“已看”（代码审 可选 3）', () => {
  it('打开一条已删除的 AI 未看过的随手记：不写 category_seen', async () => {
    const b = await boot();
    await seed(b, { category_source: 'ai', category_seen: false, deleted_at: 5 });
    open(`#/note/${ID}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(await patches(b)).toHaveLength(0);
    expect(notes().getSnapshot()[0]?.['category_seen']).toBe(false);
  });
});
