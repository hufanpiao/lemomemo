// 日程编辑页（B2 FA-2 第一段；TC-B2-02 地点 / 链接、时区提示、全天切换）
// 和待办编辑页同一套：真实的冷启动（假 IndexedDB），写入经 write.* 进 outbox，再从集合读回来
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { pendingNewDate, watchAddClick } from '../hooks/new-date.ts';
import EventEditPage from '../ui/EventEditPage.tsx';

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

  it('javascript: 只显示文字，不是链接；改地点照样存', async () => {
    const b = await boot();
    await b.outbox?.applyServer('events', [{ row: serverEvent() }]);
    const { container } = open(`#/event/${ID}`);
    await commitText('event-edit-location', 'javascript:alert(1)');
    await waitFor(() => expect(events().get(ID)?.['location']).toBe('javascript:alert(1)'));
    expect(screen.getByText('javascript:alert(1)', { selector: 'span' })).toBeTruthy();
    expect(container.querySelector('a[href]')).toBeNull();
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
    expect((screen.getByTestId('event-edit-tz') as HTMLSelectElement).value).toBe(other);
  });

  it('不在 Intl 表里的时区选不了：不写，状态报 rejected', async () => {
    const b = await boot();
    await b.outbox?.applyServer('events', [{ row: serverEvent() }]);
    open(`#/event/${ID}`);
    const before = (await b.outbox?.list())?.length ?? 0;
    await act(async () => {
      fireEvent.change(screen.getByTestId('event-edit-tz'), { target: { value: 'Mars/Base' } });
    });
    expect((await b.outbox?.list())?.length ?? 0).toBe(before);
    expect(events().get(ID)?.['tz']).toBe(currentTz());
    // 拦下了要告诉用户（代码审查 S5）
    expect(screen.getByTestId('edit-status').textContent).toBe('格式不对，没保存上（标题太长、日期或时区不对）');
  });
});

describe('全天切换', () => {
  it('改成全天：时刻、时区一起清，提醒换成“当天 / 前一天”；同一页里改回来：恢复原来的时刻、时区、提醒（S3）', async () => {
    const b = await boot();
    await b.outbox?.applyServer('events', [{ row: serverEvent() }]);
    open(`#/event/${ID}`);
    expect(screen.getByTestId('event-edit-start')).toBeTruthy();
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
    expect((screen.getByTestId('event-edit-start') as HTMLInputElement).value).toBe('15:00');
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
    expect((screen.getByTestId('event-edit-start') as HTMLInputElement).value).toBe('09:00');
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
  it('默认是日历上选中的那天；表单挂上以后清掉，下次新建回到今天', async () => {
    await boot();
    const stop = watchAddClick(() => '2026-11-09');
    const add = document.createElement('button');
    add.dataset['testid'] = 'tabbar-add';
    document.body.append(add);
    add.click();
    stop();
    add.remove();
    const view = open('#/event/new');
    expect((screen.getByTestId('event-edit-date') as HTMLInputElement).value).toBe('2026-11-09');
    expect(pendingNewDate()).toBeNull();
    view.unmount();
    open('#/event/new');
    expect((screen.getByTestId('event-edit-date') as HTMLInputElement).value).toBe(todayOf(NOW, currentTz()));
  });
});
