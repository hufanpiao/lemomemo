// 日程编辑页（B2 FA-2 第一段；TC-B2-02 地点 / 链接、时区提示、全天切换）
// 和待办编辑页同一套：真实的冷启动（假 IndexedDB），写入经 write.* 进 outbox，再从集合读回来
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt, todayOf } from '../../../../shared/core/date.ts';
import { coldStart, getBoot, resetBootForTest } from '../../../core/boot.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import type { ServerRow } from '../../../core/cache.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { clearAllCollections, collection } from '../../../core/store.ts';
import { clock } from '../../../platform/clock.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { navigate } from '../../../app/router.ts';
import { pendingNewDate } from '../hooks/new-date.ts';
import { setNewItem } from '../../../kit/state/new-item.ts';
import EventEditPage from '../ui/EventEditPage.tsx';
import { openPick, pickValue, valueOf } from '../../../kit/components/__tests__/pick-dom.ts';

const ID = '00000000-0000-4000-8000-0000000000b1';
const NOW = msAt('2026-11-05', 9 * 60, 'Asia/Seoul');
type Row = { id: string } & Record<string, unknown>;
const events = () => collection<Row>('events');

async function boot() {
  const { factory } = fakeIndexedDB();
  return coldStart({
    userId: 'A', appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
}

const serverEvent = (over: Record<string, unknown> = {}): ServerRow =>
  ({
    id: ID, title: '客户反馈会', date: '2026-11-06', time: '15:00', tz: currentTz(), duration_min: 60, project: '', note: '', source: 'page',
    raw_text: '', location: '', short: null, short_by: null, push_show_title: null, batch_id: null, remind_min: 15, remind_days: null,
    notified_for: null, snooze_at: null, deleted_at: null, undone: false, created_at: 1, updated_at: 1, rev: 2, ...over,
  }) as ServerRow;

function open(hash: string) {
  window.history.replaceState(null, '', `/app/${hash}`);
  return render(<EventEditPage />);
}

async function commitText(testId: string, value: string) {
  const el = screen.getByTestId(testId);
  fireEvent.focus(el);
  fireEvent.change(el, { target: { value } });
  await act(async () => {
    fireEvent.blur(el);
  });
}

/** 结束日期选择器里那一天的格子（打开选择器、按周翻到那一周；看完不收起） */
function dayCell(testId: string, day: string): HTMLButtonElement {
  const box = openPick(testId);
  for (let i = 0; i < 80 && !box.querySelector(`[data-v="${day}"]`); i++) {
    const first = box.querySelector<HTMLElement>('[data-v^="2"]')?.dataset['v'] ?? '';
    fireEvent.click(within(box).getByTestId(first > day ? 'pick-prev' : 'pick-next'));
  }
  return box.querySelector(`[data-v="${day}"]`) as HTMLButtonElement;
}

/** 一直往后翻到箭头禁用，最后一个能点的日子（= 能选的最晚那天）；看完收起 */
function lastDay(testId: string): string {
  const box = openPick(testId);
  for (let i = 0; i < 20 && !(within(box).getByTestId('pick-next') as HTMLButtonElement).disabled; i++) fireEvent.click(within(box).getByTestId('pick-next'));
  const ok = [...box.querySelectorAll<HTMLButtonElement>('[data-v^="2"]')].filter((b) => !b.disabled);
  fireEvent.click(screen.getByTestId(testId));
  return ok.at(-1)?.dataset['v'] ?? '';
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

describe('地点 / 链接（TC-B2-02，SAFE-link-real）', () => {
  it('https 链接：下面显示成可点的链接，新窗口打开、noopener noreferrer', async () => {
    const b = await boot();
    await b.outbox?.applyServer('events', [{ row: serverEvent({ location: 'https://meet.example.com/abc' }) }]);
    open(`#/event/${ID}`);
    const a = screen.getByText('https://meet.example.com/abc', { selector: 'a' });
    expect(a.getAttribute('href')).toBe('https://meet.example.com/abc');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.getAttribute('target')).toBe('_blank');
  });

  it('javascript: 不是链接，下面不出那一行；改地点照样存', async () => {
    const b = await boot();
    await b.outbox?.applyServer('events', [{ row: serverEvent() }]);
    const { container } = open(`#/event/${ID}`);
    await commitText('event-edit-location', 'javascript:alert(1)');
    await waitFor(() => expect(events().get(ID)?.['location']).toBe('javascript:alert(1)'));
    expect(screen.queryByText('javascript:alert(1)', { selector: 'span, a' })).toBeNull();
    expect(container.querySelector('a[href]')).toBeNull();
  });

  it('普通地名：只在输入框里，下面不再原样写一遍（R-436 丙批）', async () => {
    const b = await boot();
    await b.outbox?.applyServer('events', [{ row: serverEvent({ location: '연남동' }) }]);
    open(`#/event/${ID}`);
    expect((screen.getByTestId('event-edit-location') as HTMLInputElement).value).toBe('연남동');
    expect(screen.queryByText('연남동')).toBeNull();
  });
});

describe('时区提示（架构 4.6）', () => {
  it('日程时区和当前时区一样：不提示；不一样：写出“在你这里是…”', async () => {
    const b = await boot();
    const other = currentTz() === 'America/Los_Angeles' ? 'Asia/Seoul' : 'America/Los_Angeles';
    await b.outbox?.applyServer('events', [{ row: serverEvent() }]);
    const r1 = open(`#/event/${ID}`);
    expect(screen.queryByText(/在你这里是/)).toBeNull();
    r1.unmount();
    await b.outbox?.applyServer('events', [{ row: serverEvent({ tz: other, rev: 3, updated_at: 2 }) }]);
    open(`#/event/${ID}`);
    expect(screen.getByText(/按这个时区的时间；在你这里是 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)).toBeTruthy();
    expect(valueOf('event-edit-tz')).toBe(other);
  });

  // 11-21 起时区是 kit 单选清单（400 多项上下滚，不加搜索）：只列 Intl 表里的，表外的根本没有这一格；选别的照常写
  it('时区单选只列 Intl 表里的：没有 Mars/Base 这一格；选另一个时区就写进去', async () => {
    const b = await boot();
    await b.outbox?.applyServer('events', [{ row: serverEvent() }]);
    open(`#/event/${ID}`);
    const other = currentTz() === 'America/Los_Angeles' ? 'Asia/Seoul' : 'America/Los_Angeles';
    const box = openPick('event-edit-tz');
    expect(box.querySelector('[data-v="Mars/Base"]')).toBeNull();
    expect(box.querySelector(`[data-v="${currentTz()}"]`)?.getAttribute('aria-checked')).toBe('true');
    await pickValue('event-edit-tz', other);
    await waitFor(() => expect(events().get(ID)?.['tz']).toBe(other));
    expect(valueOf('event-edit-tz')).toBe(other);
  });
});

describe('结束日期、时刻（R-444 跨天日程）', () => {
  it('有时刻：结束一行是“日期 + 时刻”；选到后天 18:00，时长写成真实分钟，提醒不动', async () => {
    const b = await boot();
    await b.outbox?.applyServer('events', [{ row: serverEvent() }]);
    open(`#/event/${ID}`);
    expect(valueOf('event-edit-end-date')).toBe('2026-11-06');
    // 开始当天之前灰掉；有时刻的也是开始 + 30 天（评审第 4 条）
    expect(dayCell('event-edit-end-date', '2026-11-05').disabled).toBe(true);
    expect(dayCell('event-edit-end-date', '2026-11-06').disabled).toBe(false);
    expect(lastDay('event-edit-end-date')).toBe('2026-12-06');
    expect(valueOf('event-edit-end')).toBe('16:00');
    await pickValue('event-edit-end-date', '2026-11-08');
    await waitFor(() => expect(events().get(ID)?.['duration_min']).toBe(2 * 1440 + 60));
    await pickValue('event-edit-end', '18:00');
    await waitFor(() => expect(events().get(ID)?.['duration_min']).toBe(2 * 1440 + 180));
    expect(valueOf('event-edit-end-date')).toBe('2026-11-08');
    expect(events().get(ID)).toMatchObject({ date: '2026-11-06', time: '15:00', remind_min: 15 });
  });

  // 11-21 起结束日期早于开始的那几天在选择器里灰掉、点不了（原来原生框能敲进去，再按开始那天算并提示）；
  // 同一天选得比开始早算跨夜（durationTo），选择器提示“比开始早，算到第二天”
  it('结束早于开始的日子点不了；同一天选得比开始早：提示算到第二天，记成跨夜', async () => {
    const b = await boot();
    await b.outbox?.applyServer('events', [{ row: serverEvent() }]);
    open(`#/event/${ID}`);
    expect(dayCell('event-edit-end-date', '2026-11-04').disabled).toBe(true);
    fireEvent.click(screen.getByTestId('event-edit-end-date'));
    const box = openPick('event-edit-end');
    expect(within(box).getByTestId('pick-hint').textContent).toBe('结束可选 11/6～12/6');
    fireEvent.click(box.querySelector('[data-v="h08"]') as HTMLElement);
    expect(within(box).getByTestId('pick-hint').textContent).toBe('比开始早，算到第二天');
    await pickValue('event-edit-end', '08:00');
    await waitFor(() => expect(events().get(ID)?.['duration_min']).toBe(17 * 60));
  });

  it('全天：结束只有日期；选到 3 天后记成 4 × 1440，改开始日期时整段跟着挪', async () => {
    const b = await boot();
    await b.outbox?.applyServer('events', [{ row: serverEvent({ time: null, tz: null, remind_min: null, remind_days: 0 }) }]);
    open(`#/event/${ID}`);
    expect(screen.queryByTestId('event-edit-end')).toBeNull();
    expect(valueOf('event-edit-end-date')).toBe('2026-11-06');
    expect(lastDay('event-edit-end-date')).toBe('2026-12-06');
    await pickValue('event-edit-end-date', '2026-11-09');
    await waitFor(() => expect(events().get(ID)?.['duration_min']).toBe(4 * 1440));
    await pickValue('event-edit-date', '2026-11-10');
    await waitFor(() => expect(events().get(ID)?.['date']).toBe('2026-11-10'));
    expect(valueOf('event-edit-end-date')).toBe('2026-11-13');
  });

  it('跨 3 天的有时刻日程切成全天：记 3 天；同一页切回来恢复原来的时刻和时长', async () => {
    const b = await boot();
    await b.outbox?.applyServer('events', [{ row: serverEvent({ duration_min: 2 * 1440 + 60 }) }]);
    open(`#/event/${ID}`);
    await act(async () => {
      fireEvent.click(screen.getByTestId('event-edit-allday'));
    });
    await waitFor(() => expect(events().get(ID)).toMatchObject({ time: null, duration_min: 3 * 1440 }));
    expect(valueOf('event-edit-end-date')).toBe('2026-11-08');
    await act(async () => {
      fireEvent.click(screen.getByTestId('event-edit-allday'));
    });
    await waitFor(() => expect(events().get(ID)).toMatchObject({ time: '15:00', duration_min: 2 * 1440 + 60 }));
  });
});

describe('全天切换', () => {
  it('改成全天：时刻、时区一起清，提醒换成“当天 / 前一天”；同一页里改回来：恢复原来的时刻、时区、提醒（S3）', async () => {
    const b = await boot();
    await b.outbox?.applyServer('events', [{ row: serverEvent() }]);
    open(`#/event/${ID}`);
    expect(screen.getByTestId('event-edit-start')).toBeTruthy();
    // “全天”是开关（B2-UI-b W5，D2 ①）
    expect(screen.getByTestId('event-edit-allday').getAttribute('role')).toBe('switch');
    await act(async () => {
      fireEvent.click(screen.getByTestId('event-edit-allday'));
    });
    await waitFor(() => expect(events().get(ID)).toMatchObject({ time: null, tz: null }));
    expect(screen.queryByTestId('event-edit-start')).toBeNull();
    expect(screen.queryByTestId('event-edit-tz')).toBeNull();
    expect(screen.getByTestId('event-edit-days')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('event-edit-allday'));
    });
    await waitFor(() => expect(events().get(ID)).toMatchObject({ time: '15:00', tz: currentTz(), remind_min: 15 }));
    expect(valueOf('event-edit-start')).toBe('15:00');
  });

  it('一开始就是全天的：改成有时刻用 9:00、本机时区', async () => {
    const b = await boot();
    await b.outbox?.applyServer('events', [{ row: serverEvent({ time: null, tz: null, remind_min: null, remind_days: 0 }) }]);
    open(`#/event/${ID}`);
    expect(screen.queryByTestId('event-edit-start')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('event-edit-allday'));
    });
    await waitFor(() => expect(events().get(ID)).toMatchObject({ time: '09:00' }));
    expect(typeof events().get(ID)?.['tz']).toBe('string');
    expect(valueOf('event-edit-start')).toBe('09:00');
  });

  it('新建：写上标题就 insert 整行，默认今天 9:00、提醒 15 分钟', async () => {
    await boot();
    open('#/event/new');
    await commitText('event-edit-title', '看牙');
    await waitFor(() => expect(events().getSnapshot()).toHaveLength(1));
    expect(events().getSnapshot()[0]).toMatchObject({ title: '看牙', time: '09:00', remind_min: 15, source: 'page', created_at: NOW });
    // N2：保存后再点“新建”是一张空表，写的是新的一行，不改到刚才那条
    const first = events().getSnapshot()[0]?.id ?? '';
    await waitFor(() => expect(window.location.hash).toBe(`#/event/${first}`));
    await act(async () => {
      await navigate('event', 'new');
    });
    await waitFor(() => expect((screen.getByTestId('event-edit-title') as HTMLInputElement).value).toBe(''));
    await commitText('event-edit-title', '取快递');
    await waitFor(() => expect(events().getSnapshot()).toHaveLength(2));
    expect(events().get(first)?.['title']).toBe('看牙');
  });
});

describe('从日历页点“＋”新建（FA-7 第 5 项）', () => {
  it('默认是带过来的那天（打字条“展开编辑”时 App 放进来）；表单挂上以后清掉，下次新建回到今天', async () => {
    await boot();
    setNewItem({ day: '2026-11-09' });
    const view = open('#/event/new');
    expect(valueOf('event-edit-date')).toBe('2026-11-09');
    expect(pendingNewDate()).toBeNull();
    view.unmount();
    open('#/event/new');
    expect(valueOf('event-edit-date')).toBe(todayOf(NOW, currentTz()));
  });
});

describe('只读行（0.27①“只读显示”，FA-2 视觉验收第 2 条）', () => {
  it('一进来顶部就出“这条要新版本才能修改 · 更新”；输入全禁用、没有“删除”、不写“改了就自动保存”；可写的行照旧', async () => {
    const b = await boot();
    await b.outbox?.applyServer('events', [{ row: serverEvent(), ro: true }]);
    open(`#/event/${ID}`);
    expect(screen.getByTestId('edit-notice').textContent).toContain('这条要新版本才能修改');
    expect(screen.getByTestId('event-edit-update')).toBeTruthy();
    expect(screen.getByTestId('edit-status').textContent).toBe('');
    expect(screen.queryByTestId('event-edit-delete')).toBeNull();
    // 日期、时刻、下拉的值按钮（kit 选择器，带 data-value）也要禁用
    for (const el of document.querySelectorAll<HTMLInputElement>('[data-testid="event-edit"] input, [data-testid="event-edit"] textarea, [data-testid="event-edit"] button[data-value]')) {
      expect(el.disabled, el.dataset['testid'] ?? el.name).toBe(true);
    }
    cleanup();
    await b.outbox?.applyServer('events', [{ row: serverEvent({ rev: 9 }) }]);
    open(`#/event/${ID}`);
    expect(screen.getByTestId('event-edit-delete')).toBeTruthy();
    expect(screen.getByTestId('edit-status').textContent).toBe('');   // R-436：没改过不写字（原“改了就自动保存”）
  });
});

describe('‹ 返回（iOS 主屏幕版恢复后退出 App，代码审查 M1）', () => {
  it('直接打开（推送、旧版留下的 state，没有返回栈）：原地换成今天，不调用 history.back()', async () => {
    await boot();
    window.history.replaceState({ lemoDepth: 1, lemoDoc: 'old-load' }, '', `/app/#/event/${ID}`);
    render(<EventEditPage />);
    const b = vi.spyOn(window.history, 'back');
    await act(async () => {
      fireEvent.click(screen.getByTestId('edit-back'));
    });
    expect(b).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/today');
  });

  it('App 里从月历点进来的：退回那一页（返回栈，R-487），不调用 history.back()', async () => {
    await boot();
    window.history.replaceState(null, '', '/app/#/cal/month/2026-12');
    await navigate('event', ID);
    render(<EventEditPage />);
    const b = vi.spyOn(window.history, 'back');
    await act(async () => {
      fireEvent.click(screen.getByTestId('edit-back'));
    });
    expect(b).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/cal/month/2026-12');
  });
});

describe('新建保存晚到（b2-tabbar e2e，CI 审查员 11-10）', () => {
  it('在新建页上正常保存：地址换成 #/event/<id>（不压历史，S7），编辑器不重挂', async () => {
    await boot();
    open('#/event/new');
    const before = screen.getByTestId('event-edit-title');
    const len = window.history.length;
    await commitText('event-edit-title', '见客户');
    await waitFor(() => expect(events().getSnapshot()).toHaveLength(1));
    const id = events().getSnapshot()[0]?.id;
    await waitFor(() => expect(window.location.hash).toBe(`#/event/${id}`));
    expect(window.history.length).toBe(len);
    expect(screen.getByTestId('event-edit-title')).toBe(before);
  });

  it('写上标题后马上离开（goto #/today 并卸载）：保存照常写进去，晚到的回调不把地址改回编辑页', async () => {
    await boot();
    const { unmount } = open('#/event/new');
    const el = screen.getByTestId('event-edit-title');
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: '见客户' } });
    fireEvent.blur(el);
    window.history.replaceState(null, '', '/app/#/today');
    unmount();
    await waitFor(() => expect(events().getSnapshot()).toHaveLength(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(window.location.hash).toBe('#/today');
  });

  it('离开了但页面还没卸载：同样不改地址', async () => {
    await boot();
    open('#/event/new');
    const el = screen.getByTestId('event-edit-title');
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: '见客户' } });
    fireEvent.blur(el);
    window.history.replaceState(null, '', '/app/#/today');
    await waitFor(() => expect(events().getSnapshot()).toHaveLength(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(window.location.hash).toBe('#/today');
  });
});
