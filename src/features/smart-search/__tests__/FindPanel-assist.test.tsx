// 查找面板 B4b-3 新增（ui/FindPanel.tsx、ui/RowMenu.tsx）：每行“⋯”菜单（待办 完成 / 推迟到明天 / 改时间 / 删除，删除出撤销条）、
// “＋”判成查找打开的页脚“总结一下”“改成记下”、有结果时底部“最近找过”。写库用替身；vault、notes 是别的功能，用替身
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistAsk } from '../../../../shared/logic/parse/assist.ts';
import { collection } from '../../../core/store.ts';
import { setConsentStale } from '../../../kit/state/consent-fresh.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import type * as Session from '../../../platform/session.ts';
import { addRecent } from '../data/find-recent.ts';
import { closeFind, findOpenSnapshot, type AssistReq } from '../hooks/find-open.ts';
import FindPanel from '../ui/FindPanel.tsx';

const SID = 'sid-fm';
vi.mock('../../../platform/session.ts', async (orig) => ({ ...(await orig<typeof Session>()), readSessionId: () => SID }));
const fx = vi.hoisted(() => ({ save: vi.fn(), search: vi.fn(), nav: vi.fn(), logs: [] as string[] }));
vi.mock('../data/note-search-api.ts', () => ({ noteSearch: (...a: unknown[]) => fx.search(...a) }));
vi.mock('../../../core/edit-save.ts', () => ({ savePatch: (...a: unknown[]) => fx.save(...a) }));
vi.mock('../../../app/router.ts', async (orig) => ({ ...(await orig<object>()), navigate: (...a: unknown[]) => fx.nav(...a) }));
vi.mock('../../../platform/run-log-api.ts', async (orig) => ({ ...(await orig<object>()), rlog: (l: string) => fx.logs.push(l) }));
// 别的功能的懒加载组件（ESLint boundaries）：替身什么都不画
vi.mock('../../vault/index.ts', () => ({ VaultParts: () => null }));
vi.mock('../../notes/index.ts', () => ({ TodayNotes: () => null }));

const NOW = Date.UTC(2026, 10, 14, 3);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const live = { deleted_at: null, undone: false, updated_at: NOW };
type R = { id: string } & Record<string, unknown>;
const put = (name: string, rows: R[]) => collection<R>(name).upsert(rows);

function seed() {
  put('events', [{ id: id(1), ...live, title: '交发票会议', location: '', note: '', date: '2026-11-16', time: '12:00', tz: null, duration_min: 60 }]);
  put('todos', [{ id: id(2), ...live, title: '交发票', note: '', project: '', due: '2026-11-20', due_time: null, done: false, done_at: null }]);
  // AI 关着：只按关键词，不调服务器
  put('settings', [{ id: 'set-ai', key: 'ai.enabled', value: false, deleted_at: null, updated_at: NOW }]);
}
const ASK: AssistAsk = { intent: 'search', query: { text: '发票', range: null, kinds: ['event', 'todo', 'note'], done: 'any' } };
const assist = (over: Partial<AssistReq> = {}): AssistReq => ({ ask: ASK, raw: '帮我找发票', aiUsed: 0, from: 'plus', record: null, exclude: [], undoSaved: null, onClose: null, ...over });
const rowOf = (kind: string) => {
  const r = screen.getAllByTestId('find-row').find((b) => b.getAttribute('data-kind') === kind);
  if (!r) throw new Error(`没有 ${kind} 行`);
  return r;
};
const openMenu = (kind: string) => {
  const more = rowOf(kind).parentElement?.querySelector('[data-testid="find-row-more"]');
  if (!more) throw new Error('没有“⋯”');
  fireEvent.click(more);
};
const flush = () => act(async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
});

beforeEach(() => {
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  uiStore.getState().setLocale('zh-CN');
  setConsentStale(false, SID);
  fx.save.mockReset().mockResolvedValue('saved');
  fx.search.mockReset();
  fx.nav.mockReset();
  fx.logs.length = 0;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
  seed();
});
afterEach(() => {
  cleanup();
  closeFind();
  for (const c of ['events', 'todos', 'settings']) collection(c).clear();
  vi.restoreAllMocks();
});

describe('查找面板：每行“⋯”菜单', () => {
  it('待办：完成 / 推迟到明天 / 改时间 / 删除；日程：编辑 / 删除', () => {
    render(<FindPanel query="发票" from="ctrlk" onClose={vi.fn()} />);
    openMenu('todo');
    expect(['done', 'tomorrow', 'retime', 'delete'].map((x) => screen.getByTestId(`find-m-${x}`).textContent)).toEqual(['完成', '推迟到明天', '改时间', '删除']);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    cleanup();
    render(<FindPanel query="发票" from="ctrlk" onClose={vi.fn()} />);
    openMenu('event');
    expect(screen.getByTestId('find-m-edit')).toBeTruthy();
    expect(screen.getByTestId('find-m-delete')).toBeTruthy();
    expect(screen.queryByTestId('find-m-done')).toBeNull();
  });

  it('点删除：软删这一行，出“已删除 · 撤销”；点撤销写回', async () => {
    render(<FindPanel query="发票" from="ctrlk" onClose={vi.fn()} />);
    openMenu('todo');
    fireEvent.click(screen.getByTestId('find-m-delete'));
    await flush();
    expect(fx.save).toHaveBeenCalledWith('todos', id(2), { deleted_at: NOW, updated_at: NOW }, true);
    const toast = screen.getByTestId('find-undo');
    expect(toast.textContent).toContain('已删除');
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    await flush();
    expect(fx.save).toHaveBeenLastCalledWith('todos', id(2), { deleted_at: null, updated_at: NOW }, true);
    expect(fx.logs.join('\n')).toMatch(/find act delete kind=todo ok=1/);
    expect(fx.logs.join('\n')).toMatch(/find act undo n=1/);
  });

  it('写失败：只出“没改成”的提示（alert），没有撤销按钮', async () => {
    fx.save.mockResolvedValue('failed');
    render(<FindPanel query="发票" from="ctrlk" onClose={vi.fn()} />);
    openMenu('todo');
    fireEvent.click(screen.getByTestId('find-m-delete'));
    await flush();
    const toast = screen.getByTestId('find-undo');
    expect(toast.getAttribute('role')).toBe('alert');
    expect(screen.queryByTestId('find-undo-undo')).toBeNull();
  });

  it('点完成：写 done；改时间：去编辑页、关面板', async () => {
    const onClose = vi.fn();
    render(<FindPanel query="发票" from="ctrlk" onClose={onClose} />);
    openMenu('todo');
    fireEvent.click(screen.getByTestId('find-m-done'));
    await flush();
    expect(fx.save).toHaveBeenCalledWith('todos', id(2), { done: true, done_at: NOW, updated_at: NOW }, true);
    expect(screen.getByTestId('find-undo').textContent).toContain('已完成');
    openMenu('todo');
    fireEvent.click(screen.getByTestId('find-m-retime'));
    expect(fx.nav).toHaveBeenCalledWith('todo', id(2));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('查找面板：“＋”判成查找打开的（assist）', () => {
  it('assist 为 null：页脚没有“总结一下”“改成记下”', () => {
    render(<FindPanel query="发票" from="ctrlk" onClose={vi.fn()} />);
    expect(screen.queryByTestId('find-summarize')).toBeNull();
    expect(screen.queryByTestId('find-record')).toBeNull();
  });

  it('assist 不为 null：“总结一下”换成结果层（意图 summarize、查询词是输入框里的）', () => {
    render(<FindPanel query="发票" from="plus" assist={assist()} onClose={vi.fn()} />);
    expect(screen.queryByTestId('find-record')).toBeNull();
    fireEvent.click(screen.getByTestId('find-summarize'));
    expect(findOpenSnapshot()?.assist?.ask).toMatchObject({ intent: 'summarize', query: { text: '发票' } });
  });

  it('一条都没找到：不给“总结一下”，“改成记下”照样在', () => {
    render(<FindPanel query="不存在的词" from="plus" assist={assist({ record: vi.fn(async () => {}) })} onClose={vi.fn()} />);
    expect(screen.getByTestId('find-empty')).toBeTruthy();
    expect(screen.queryByTestId('find-summarize')).toBeNull();
    expect(screen.getByTestId('find-record')).toBeTruthy();
  });

  it('record 不为 null：“改成记下”调 record 并关；排除刚保存的 id', () => {
    const record = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<FindPanel query="发票" from="plus" assist={assist({ record, exclude: [id(2)] })} onClose={onClose} />);
    expect(screen.getAllByTestId('find-row').map((r) => r.getAttribute('data-kind'))).toEqual(['event']);
    fireEvent.click(screen.getByTestId('find-record'));
    expect(record).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('查找面板：有结果时底部也有“最近找过”', () => {
  it('有最近记录：结果下面列出来，点了换成这个查询', () => {
    addRecent('会议');
    render(<FindPanel query="发票" from="ctrlk" onClose={vi.fn()} />);
    expect(screen.getAllByTestId('find-row').length).toBeGreaterThan(0);
    expect(screen.getByText('最近找过')).toBeTruthy();
    const chip = screen.getAllByTestId('find-recent').find((b) => b.textContent === '会议');
    if (!chip) throw new Error('没有“会议”');
    fireEvent.click(chip);
    expect((screen.getByTestId('find-input') as HTMLInputElement).value).toBe('会议');
  });
});
