// 结果层（ui/AssistPanel.tsx、hooks/useAssist.ts；B4b-3，架构 5.14 第 2～4、7 点）：时间类查找按日子分组、“理解成：”、没有截止日期提示；
// 总结（打开就总结、成功 / 失败文案、cited 标记、这次用了 N 次 AI）；取消、改期卡片（写入、撤销、没候选、泛指词、批量勾选）；“改成记下”。
// 总结、写库一律用替身，不联网、不碰本机库的写入
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistAsk } from '../../../../shared/logic/parse/assist.ts';
import type { PlusQuery } from '../../../../shared/schema/intent.ts';
import { collection } from '../../../core/store.ts';
import { setConsentStale } from '../../../kit/state/consent-fresh.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import type * as Session from '../../../platform/session.ts';
import type { AssistReq } from '../hooks/find-open.ts';
import AssistPanel from '../ui/AssistPanel.tsx';
import { whenText } from '../ui/find-parts.tsx';

const SID = 'sid-a';
vi.mock('../../../platform/session.ts', async (orig) => ({ ...(await orig<typeof Session>()), readSessionId: () => SID }));
const fx = vi.hoisted(() => ({ sum: vi.fn(), wait: vi.fn(), save: vi.fn(), nav: vi.fn(), logs: [] as string[] }));
vi.mock('../data/summarize-api.ts', () => ({ summarize: (...a: unknown[]) => fx.sum(...a), waitSent: (...a: unknown[]) => fx.wait(...a) }));
vi.mock('../../../core/edit-save.ts', () => ({ savePatch: (...a: unknown[]) => fx.save(...a) }));
vi.mock('../../../app/router.ts', async (orig) => ({ ...(await orig<object>()), navigate: (...a: unknown[]) => fx.nav(...a) }));
vi.mock('../../../platform/run-log-api.ts', async (orig) => ({ ...(await orig<object>()), rlog: (l: string) => fx.logs.push(l) }));

/** 2026-11-14（周六）12:00 首尔 = 03:00 UTC：日子在首尔、UTC 都是 11-14 */
const NOW = Date.UTC(2026, 10, 14, 3);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const live = { deleted_at: null, undone: false, updated_at: NOW, created_at: NOW };
type R = { id: string } & Record<string, unknown>;
const put = (name: string, rows: R[]) => collection<R>(name).upsert(rows);
const ev = (n: number, title: string, date: string, time: string | null = '12:00'): R => ({ id: id(n), ...live, title, location: '', note: '', date, time, tz: null, duration_min: 60 });
const td = (n: number, title: string, due: string | null, done = false): R => ({ id: id(n), ...live, title, note: '', project: '', due, due_time: null, done, done_at: null });

function seed() {
  put('events', [ev(1, '看牙医', '2026-11-16'), ev(2, '早会', '2026-11-16', '09:00'), ev(3, '出差', '2026-11-18', null)]);
  put('todos', [td(4, '交发票', '2026-11-16'), td(5, '买牛奶', null), td(6, '旧报告', '2026-11-10')]);
  put('notes', [{ id: id(7), ...live, title: '拉面店', body: '弘大那家', is_private: false }]);
  put('settings', [{ id: 'set-ai', key: 'ai.enabled', value: true, deleted_at: null, updated_at: NOW }]);
}

const WEEK = { from: '2026-11-16', to: '2026-11-22' };
const query = (intent: 'search' | 'summarize', over: Partial<PlusQuery> = {}): AssistAsk => ({ intent, query: { text: '', range: WEEK, kinds: ['event', 'todo'], done: 'any', ...over } });
function req(ask: AssistAsk, over: Partial<AssistReq> = {}): AssistReq {
  return { ask, raw: '下周的安排', aiUsed: 0, from: 'plus', record: null, exclude: [], undoSaved: null, onClose: null, ...over };
}
const show = (r: AssistReq, onClose = vi.fn()) => render(<AssistPanel req={r} onClose={onClose} />);
const flush = () => act(async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
});

beforeEach(() => {
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  uiStore.getState().setLocale('zh-CN');
  setConsentStale(false, SID);
  fx.sum.mockReset();
  fx.wait.mockReset().mockResolvedValue(false);
  fx.save.mockReset().mockResolvedValue('saved');
  fx.nav.mockReset();
  fx.logs.length = 0;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
  seed();
});
afterEach(() => {
  cleanup();
  for (const c of ['events', 'todos', 'notes', 'settings']) collection(c).clear();
  vi.restoreAllMocks();
});

describe('日子加时刻只拼一处（评审第 23 条，find-parts 的 whenText）', () => {
  it('日子带星期、时刻，缺哪部分就不写哪部分', () => {
    expect(whenText('2026-11-10', '15:00', 'zh-CN')).toMatch(/^11月10日.*周二 15:00$/);
    expect(whenText('2026-11-10', null, 'zh-CN')).toMatch(/周二$/);
    expect(whenText(null, '15:00', 'zh-CN')).toBe('15:00');
    expect(whenText(null, null, 'zh-CN')).toBe('');
  });
});

describe('结果层：时间类查找', () => {
  it('按日子分组出行、日子里按时刻排；“理解成：…”；没有截止日的待办不进，写一句提示', () => {
    show(req(query('search')));
    const days = screen.getAllByTestId('assist-day');
    expect(days).toHaveLength(2);
    const rowsOf = (i: number) => [...(days[i]?.querySelectorAll('[data-testid="assist-row"]') ?? [])].map((b) => b.textContent ?? '');
    expect(rowsOf(0)).toEqual([expect.stringContaining('早会'), expect.stringContaining('看牙医'), expect.stringContaining('交发票')]);
    expect(rowsOf(1)[0]).toContain('出差');
    expect(screen.queryByText(/买牛奶/)).toBeNull();
    const und = screen.getByTestId('assist-understand').textContent ?? '';
    expect(und.startsWith('理解成：')).toBe(true);
    expect(und).toContain('日程和待办');
    expect(screen.getByText('没有截止日期的待办不在里面')).toBeTruthy();
    expect(fx.sum).not.toHaveBeenCalled();
  });

  it('只要日程：不写“没有截止日期”那句；一条都没有：写“没有找到”', () => {
    show(req(query('search', { kinds: ['event'], range: { from: '2026-12-01', to: '2026-12-31' } })));
    expect(screen.queryByText('没有截止日期的待办不在里面')).toBeNull();
    expect(screen.getByTestId('assist-empty').textContent).toContain('没有找到');
  });

  it('截止到今天还没做完的：理解成里写过期条数', () => {
    show(req(query('search', { kinds: ['todo'], done: 'open', range: { from: null, to: '2026-11-14' } })));
    expect(screen.getByTestId('assist-understand').textContent).toContain('含以前过期的 1 条');
    expect(screen.getAllByTestId('assist-row')).toHaveLength(1);
  });
});

describe('结果层：总结', () => {
  it('意图是总结：打开就调总结；成功显示总结文字、cited 的行标出来、“这次用了 N 次 AI”', async () => {
    fx.sum.mockResolvedValue({ ok: true, summary: '下周主要是看牙医', cited: [id(1)], missing: [], quotaLeft: 8 });
    show(req(query('summarize'), { aiUsed: 1 }));
    expect(screen.getByTestId('assist-summary').getAttribute('data-state')).toBe('wait');
    await flush();
    expect(fx.wait).toHaveBeenCalledTimes(1);
    expect(fx.sum).toHaveBeenCalledTimes(1);
    expect(fx.sum.mock.calls[0]?.[0]).toMatchObject({ ids: expect.arrayContaining([{ kind: 'event', id: id(1) }, { kind: 'todo', id: id(4) }]) });
    expect(screen.getByTestId('assist-summary-text').textContent).toBe('下周主要是看牙医');
    const cited = screen.getAllByTestId('assist-row').filter((b) => b.getAttribute('data-cited') === '1');
    expect(cited.map((b) => b.textContent)).toEqual([expect.stringContaining('看牙医')]);
    expect(screen.getByText('这次用了 2 次 AI')).toBeTruthy();
    expect(fx.logs.join('\n')).not.toContain('看牙医');
  });

  it.each([
    ['quota', '今天的 AI 次数用完了'],
    ['consent', '没同意 AI 处理'],
    ['all_missing', '这些还没同步上'],
    ['failed', 'AI 这次没回应'],
  ])('总结失败（%s）：写原因“%s”', async (reason, text) => {
    fx.sum.mockResolvedValue({ ok: false, reason, code: 'x' });
    show(req(query('summarize')));
    await flush();
    const fail = screen.getByTestId('assist-summary-fail');
    expect(fail.getAttribute('data-reason')).toBe(reason);
    expect(fail.textContent).toContain(text);
    expect(screen.queryByText(/这次用了/)).toBeNull();
  });

  it('离线：不调总结，直接写没有网络', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    show(req(query('summarize')));
    await flush();
    expect(fx.sum).not.toHaveBeenCalled();
    expect(screen.getByTestId('assist-summary-fail').getAttribute('data-reason')).toBe('offline');
  });

  it('查找意图：页脚“总结一下”，点了才调', async () => {
    fx.sum.mockResolvedValue({ ok: true, summary: '两件事', cited: [], missing: [id(4)], quotaLeft: 8 });
    show(req(query('search')));
    expect(fx.sum).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('assist-summarize'));
    await flush();
    expect(fx.sum).toHaveBeenCalledTimes(1);
    expect(screen.getByText('1 条还没同步，没算进总结')).toBeTruthy();
    expect(screen.queryByTestId('assist-summarize')).toBeNull();
  });
});

const target = (intent: 'cancel' | 'reschedule' | 'complete', text: string, over: Record<string, unknown> = {}): AssistAsk => ({
  intent, target: { text, date: null, time: null, kinds: ['event', 'todo'], ...over }, to: null, bulkRefused: false, relatedTodos: false,
});

describe('结果层：取消、改期、完成卡片', () => {
  it('有候选：点“取消这条”写入（软删）、撤销刚保存的这一批，出“已取消：…”和撤销；点撤销写回', async () => {
    const undoSaved = vi.fn(async () => {});
    show(req(target('cancel', '牙医'), { undoSaved }));
    expect(screen.getByTestId('assist-understand').textContent).toBe('理解成：取消 牙医');
    const btn = screen.getByTestId('assist-cand-act');
    expect(btn.textContent).toBe('取消这条');
    fireEvent.click(btn);
    await flush();
    expect(fx.save).toHaveBeenCalledWith('events', id(1), { deleted_at: NOW, updated_at: NOW }, true);
    expect(undoSaved).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('assist-target-done').textContent).toContain('已取消：看牙医');
    fireEvent.click(screen.getByTestId('assist-undo'));
    await flush();
    expect(fx.save).toHaveBeenLastCalledWith('events', id(1), { deleted_at: null, updated_at: NOW }, true);
    expect(screen.getByTestId('assist-target-done').textContent).toContain('已撤销');
  });

  it('“这次用了 N 次 AI”只出一行（面板页脚出；卡片自己的按钮行不再重复，11-14 评审截图里出了两遍）', () => {
    show(req(target('cancel', '牙医'), { aiUsed: 1 }));
    expect(screen.getAllByText('这次用了 1 次 AI')).toHaveLength(1);
  });

  it('写不进去：不撤销刚保存的这一批，写“1 条没改上”', async () => {
    fx.save.mockResolvedValue('rejected');
    const undoSaved = vi.fn(async () => {});
    show(req(target('cancel', '牙医'), { undoSaved }));
    fireEvent.click(screen.getByTestId('assist-cand-act'));
    await flush();
    expect(undoSaved).not.toHaveBeenCalled();
    expect(screen.getByText('1 条没改上')).toBeTruthy();
    expect(screen.queryByTestId('assist-undo')).toBeNull();
  });

  it('没候选：写“没找到对应的条目”，给“去日历里找”', () => {
    const onClose = vi.fn();
    show(req(target('cancel', '火星旅行')), onClose);
    expect(screen.getByTestId('assist-target-none').textContent).toContain('没找到对应的条目');
    fireEvent.click(screen.getByTestId('assist-go-cal'));
    expect(onClose).toHaveBeenCalled();
    expect(fx.nav).toHaveBeenCalledWith('calendar');
  });

  it('泛指词的取消（bulkRefused）：写“请在列表里操作”，不列候选', () => {
    show(req({ ...target('cancel', ''), bulkRefused: true } as AssistAsk));
    expect(screen.getByTestId('assist-target-bulk').textContent).toContain('请在列表里操作');
    expect(screen.queryByTestId('assist-cand')).toBeNull();
  });

  it('批量改期：默认全勾、一个按钮写条数；去掉一条后条数变，只写勾着的', async () => {
    const ask = { ...target('reschedule', '', { date: '2026-11-16', all: true }), to: { date: '2026-11-18', time: null } } as AssistAsk;
    show(req(ask));
    const checks = screen.getAllByTestId('assist-cand-check') as HTMLInputElement[];
    expect(checks).toHaveLength(3);
    expect(checks.every((c) => c.checked)).toBe(true);
    const batch = screen.getByTestId('assist-batch-act');
    expect(batch.textContent).toMatch(/（3 条）$/);
    const [first] = checks;
    if (!first) throw new Error('没有候选');
    fireEvent.click(first);
    expect(batch.textContent).toMatch(/（2 条）$/);
    fireEvent.click(batch);
    await flush();
    expect(fx.save).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('assist-target-done').textContent).toContain('2 条');
  });
});

describe('结果层：改成记下', () => {
  it('record 不为 null：查找有“改成记下”，点了调 record 并关', async () => {
    const record = vi.fn(async () => {});
    const onClose = vi.fn();
    show(req(query('search'), { record }), onClose);
    fireEvent.click(screen.getByTestId('assist-record'));
    expect(record).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('取消卡片叫“都不是 · 按原话记下”；record 为 null 时不出', () => {
    show(req(target('cancel', '牙医'), { record: vi.fn(async () => {}) }));
    expect(screen.getByTestId('assist-record').textContent).toBe('都不是 · 按原话记下');
    cleanup();
    show(req(query('search')));
    expect(screen.queryByTestId('assist-record')).toBeNull();
  });
});
