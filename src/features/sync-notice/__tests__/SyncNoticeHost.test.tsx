// 提示卡宿主（ui/SyncNoticeHost.tsx；K8 冲突提示方案 3.1～3.3、4.2、4.4，第五节“组件”清单）
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type { ConflictNotice, GoneNotice, Notice, NoticeSnapshot, SyncNoticeStore } from '../hooks/notice-types.ts';

let routeName = 'today';
vi.mock('../../../app/router.ts', () => ({ useRoute: () => ({ name: routeName, params: [] }) }));
// 进出场动画换成直接出现、直接消失：motion 的帧循环在 jsdom 里会被前面用例的假计时器带偏，退场有时走不完（动画本身由 motion 的测试和 e2e 管）
vi.mock('../../../motion/components.ts', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  Appear: ({ show, children, className }: { show: boolean; children: React.ReactNode; className?: string }) =>
    show ? <div className={className}>{children}</div> : null,
}));

const { default: SyncNoticeHost, clipTitle } = await import('../ui/SyncNoticeHost.tsx');

function fakeStore(queue: Notice[] = [], over: Partial<NoticeSnapshot> = {}) {
  let snap: NoticeSnapshot = { queue, hardDeleted: 0, forkSuffix: null, ...over };
  const subs = new Set<() => void>();
  const set = (s: Partial<NoticeSnapshot>): void => {
    snap = { ...snap, ...s };
    subs.forEach((f) => f());
  };
  const store: SyncNoticeStore = {
    getState: () => snap,
    subscribe: (fn) => (subs.add(fn), () => void subs.delete(fn)),
    restore: vi.fn(),
    drop: vi.fn(),
    dismiss: vi.fn((key: string) => set({ queue: snap.queue.filter((n) => n.key !== key) })),
  };
  return { store, set };
}

const conflict = (over: Partial<ConflictNotice> = {}): ConflictNotice => ({
  kind: 'conflict', key: 'todos:t1', table: 'todos', id: 't1', status: 'conflict', conflicts: ['note'], old: { note: '另一台的备注' }, forkId: null,
  title: '买牛奶', ...over,
});
const gone = (over: Partial<GoneNotice> = {}): GoneNotice => ({
  kind: 'gone', key: 'events:e1', table: 'events', id: 'e1', title: '开会', status: 'idle', ...over,
});

/** keep：dismiss 只记调用、不删卡（只靠宿主自己的过滤藏卡时用） */
function mount(queue: Notice[], over: Partial<NoticeSnapshot> = {}, keep = false) {
  const region = document.createElement('div');
  region.setAttribute('data-sync-notice', '');
  const live = document.createElement('div');
  live.setAttribute('role', 'status');
  region.append(live);
  document.body.append(region);
  const f = fakeStore(queue, over);
  if (keep) f.store.dismiss = vi.fn();
  const r = render(<SyncNoticeHost store={f.store} live={live} region={region} />, { container: region.appendChild(document.createElement('div')) });
  return { ...f, region, live, ...r };
}

beforeEach(() => {
  routeName = 'today';
  uiStore.getState().setLocale('zh-CN');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.replaceChildren();
  document.documentElement.classList.remove('scroll-locked');
});

describe('文案（3.2）', () => {
  it('有标题、无标题；标题最多 12 个字加“…”；韩文', () => {
    const { unmount } = mount([conflict({ title: '一二三四五六七八九十甲乙丙' })]);
    expect(screen.getByText('“一二三四五六七八九十甲乙…”已在另一台设备上改过')).toBeTruthy();
    expect(screen.getByText('两台设备改了同一处，现在保存的是这台设备的修改。')).toBeTruthy();
    unmount();
    mount([gone({ title: null })]);
    expect(screen.getByText('这一条已在另一台设备上删除')).toBeTruthy();
    expect(screen.getByText('这台设备上的修改还没同步。')).toBeTruthy();
    act(() => uiStore.getState().setLocale('ko-KR'));
    expect(screen.getByText('이 항목은 다른 기기에서 삭제됐어요')).toBeTruthy();
    expect(clipTitle('短')).toBe('短');
  });

  it('forked：后缀按 store 给的（ui_locale）取，取不到按界面语言；只有“知道了”（随手记页面 B3 才做）', () => {
    mount([conflict({ status: 'forked', table: 'notes', forkId: 'f1' })], { forkSuffix: '(충돌 사본)' });
    expect(screen.getByText(/标题末尾带“\(충돌 사본\)”。/)).toBeTruthy();
    expect(screen.queryByTestId('sync-notice-view')).toBeNull();
    expect(screen.getByTestId('sync-notice-ok')).toBeTruthy();
  });

  it('冲突列全是不显示的列（S1）：不出卡，替用户收掉；后面排着的照常出，也不算进“还有 n 条”', () => {
    const m = mount([conflict({ conflicts: ['updated_at', 'deleted_at'] }), gone(), conflict({ key: 'todos:t3', id: 't3', conflicts: ['note'] })], {}, true);
    expect(m.store.dismiss).toHaveBeenCalledWith('todos:t1');
    expect(screen.getByTestId('sync-notice-card').getAttribute('data-kind')).toBe('gone');
    expect(screen.getByText('还有 1 条')).toBeTruthy();
  });

  it('只有一张全是隐藏列的冲突卡：什么都不显示、不播报', async () => {
    const m = mount([conflict({ conflicts: ['updated_at'] })], {}, true);
    expect(screen.queryByTestId('sync-notice-card')).toBeNull();
    expect(m.store.dismiss).toHaveBeenCalledWith('todos:t1');
    await new Promise<void>((ok) => setTimeout(ok, 50));
    expect(m.live.textContent).toBe('');
  });

  it('收之前同一条又并进了真冲突（S1-L1）：不收', () => {
    const f = fakeStore([conflict({ conflicts: ['updated_at'] })]);
    f.store.dismiss = vi.fn();
    const before = f.store.getState();
    const merged = { ...before, queue: [conflict({ conflicts: ['updated_at', 'note'] })] };
    let after = false;
    // 渲染时看到的还是空卡；提交以后（布局副作用比被动副作用早）同一条已经并进了真冲突
    f.store.getState = () => (after ? merged : before);
    function Flip() {
      useLayoutEffect(() => {
        after = true;
      }, []);
      return null;
    }
    const region = document.body.appendChild(document.createElement('div'));
    const live = region.appendChild(document.createElement('div'));
    render(
      <>
        <SyncNoticeHost store={f.store} live={live} region={region} />
        <Flip />
      </>,
    );
    expect(f.store.dismiss).not.toHaveBeenCalled();
  });

  it('forked 不按这个滤（副本照样要说一声）', () => {
    mount([conflict({ status: 'forked', table: 'notes', forkId: 'f1', conflicts: ['updated_at'] })]);
    expect(screen.getByTestId('sync-notice-card')).toBeTruthy();
  });

  it('有排队时另起一行“还有 n 条”', () => {
    mount([conflict(), gone(), gone({ key: 'events:e2', id: 'e2' })]);
    expect(screen.getByText('还有 2 条')).toBeTruthy();
  });
});

describe('读屏（M3）', () => {
  it('容器补上按界面语言的 aria-label；下一帧往常驻 live region 写“标题 + 说明”', async () => {
    const m = mount([gone()]);
    expect(m.region.getAttribute('aria-label')).toBe('同步提示');
    await waitFor(() => expect(m.live.textContent).toBe('“开会”已在另一台设备上删除 这台设备上的修改还没同步。'));
    expect(m.region.firstElementChild).toBe(m.live);   // live region 没被重建
    act(() => m.set({ queue: [] }));   // 队列空了：去掉名字，读屏地标列表里不留空的“同步提示”（L3）
    expect(m.region.hasAttribute('aria-label')).toBe(false);
  });

  it('换卡时卡片节点换新（R2-L1）：上一张的按钮不复用，焦点不会留到下一张的按钮上', () => {
    mount([conflict(), conflict({ key: 'todos:t2', id: 't2' })]);
    const ok = screen.getByTestId('sync-notice-ok');
    ok.focus();
    fireEvent.click(ok);
    expect(screen.getByTestId('sync-notice-ok')).not.toBe(ok);
    expect(document.activeElement).not.toBe(screen.getByTestId('sync-notice-ok'));
  });
});

describe('按钮（4.2）', () => {
  it('gone：恢复、不用了各调一次；busy 时两个都禁用；永久拒收只剩“不用了”，说明换掉', () => {
    const m = mount([gone()]);
    fireEvent.click(screen.getByTestId('sync-notice-restore'));
    expect(m.store.restore).toHaveBeenCalledWith('events:e1');
    fireEvent.click(screen.getByTestId('sync-notice-drop'));
    expect(m.store.drop).toHaveBeenCalledWith('events:e1');
    act(() => m.set({ queue: [gone({ status: 'busy' })] }));
    expect((screen.getByTestId('sync-notice-restore') as HTMLButtonElement).disabled).toBe(true);
    act(() => m.set({ queue: [gone({ status: 'blocked' })] }));
    expect(screen.queryByTestId('sync-notice-restore')).toBeNull();
    expect(screen.getByText('这台设备上没法恢复这一条。')).toBeTruthy();
    act(() => m.set({ queue: [gone({ status: 'retry' })] }));
    expect(screen.getByText('没能恢复，请稍后再试。')).toBeTruthy();
  });
});

describe('计时（M3、M4）', () => {
  it('冲突卡 8 秒后自动收起；gone 卡不自动收', () => {
    vi.useFakeTimers();
    const m = mount([conflict()]);
    act(() => vi.advanceTimersByTime(7_900));
    expect(m.store.dismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(300));
    expect(m.store.dismiss).toHaveBeenCalledWith('todos:t1');
    cleanup();
    document.body.replaceChildren();
    const g = mount([gone()]);
    act(() => vi.advanceTimersByTime(60_000));
    expect(g.store.dismiss).not.toHaveBeenCalled();
  });

  it('不走的时候：页面隐藏、有弹层（scroll-locked）、指针在卡上、焦点在卡里', () => {
    vi.useFakeTimers();
    const m = mount([conflict()]);
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => vi.advanceTimersByTime(20_000));
    vis.mockRestore();
    document.documentElement.classList.add('scroll-locked');
    act(() => vi.advanceTimersByTime(20_000));
    document.documentElement.classList.remove('scroll-locked');
    fireEvent.mouseEnter(screen.getByTestId('sync-notice-card'));
    act(() => vi.advanceTimersByTime(20_000));
    fireEvent.mouseLeave(screen.getByTestId('sync-notice-card'));
    fireEvent.focus(screen.getByTestId('sync-notice-ok'));
    act(() => vi.advanceTimersByTime(20_000));
    expect(m.store.dismiss).not.toHaveBeenCalled();
    fireEvent.blur(screen.getByTestId('sync-notice-ok'));
    act(() => vi.advanceTimersByTime(8_100));
    expect(m.store.dismiss).toHaveBeenCalledTimes(1);
  });

  it('指针、焦点在卡上时点“知道了”（卡直接卸掉，收不到 mouseleave、blur）：下一张冲突卡照样 8 秒收起（代码审查 K8 界面批 M3）', () => {
    vi.useFakeTimers();
    const m = mount([conflict(), conflict({ key: 'todos:t2', id: 't2' })]);
    fireEvent.mouseEnter(screen.getByTestId('sync-notice-card'));
    fireEvent.focus(screen.getByTestId('sync-notice-ok'));
    fireEvent.click(screen.getByTestId('sync-notice-ok'));
    expect(m.store.dismiss).toHaveBeenCalledWith('todos:t1');
    act(() => vi.advanceTimersByTime(8_100));
    expect(m.store.dismiss).toHaveBeenLastCalledWith('todos:t2');
  });

  it('告知页在（main[data-feature="onboarding"]）时不走', () => {
    vi.useFakeTimers();
    const main = document.createElement('main');
    main.setAttribute('data-feature', 'onboarding');
    document.body.append(main);
    const m = mount([conflict()]);
    act(() => vi.advanceTimersByTime(20_000));
    expect(m.store.dismiss).not.toHaveBeenCalled();
  });
});

describe('路由（L4）', () => {
  it('告知页（onboarding）、整页提醒（remind）不显示卡，队列不动；回到别的页再出来', () => {
    routeName = 'remind';
    const m = mount([gone()]);
    expect(screen.queryByTestId('sync-notice-card')).toBeNull();
    routeName = 'onboarding';
    m.rerender(<SyncNoticeHost store={m.store} live={m.live} region={m.region} />);
    expect(screen.queryByTestId('sync-notice-card')).toBeNull();
    routeName = 'todo';
    m.rerender(<SyncNoticeHost store={m.store} live={m.live} region={m.region} />);
    expect(screen.getByTestId('sync-notice-card')).toBeTruthy();
  });
});

describe('对话框（3.3）', () => {
  it('“看另一台设备的版本”：列出字段名和另一台的值；打开时容器标 data-own-dialog、计时暂停；关上后去掉，焦点回到按钮', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const m = mount([conflict({ conflicts: ['note', 'zzz'] })]);
    const btn = screen.getByTestId('sync-notice-view');
    btn.focus();
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByText('另一台设备上的修改')).toBeTruthy();
    expect(screen.getByText('备注：另一台的备注')).toBeTruthy();
    expect(screen.getByText('（已改过）')).toBeTruthy();
    expect(m.region.hasAttribute('data-own-dialog')).toBe(true);
    act(() => vi.advanceTimersByTime(20_000));
    expect(m.store.dismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('sync-notice-dialog-ok'));
    await waitFor(() => expect(m.region.hasAttribute('data-own-dialog')).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('sync-notice-view')));
  });
});

describe('彻底删除的轻提示（P2）', () => {
  it('hardDeleted 变大：底部出一句，经 live region 播报，几秒后自己消失；没有卡也出', async () => {
    const realTimeout = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    // jsdom 的帧计时在上一条对话框用例里（那时 setInterval 是假的）启动过，之后不再走；这里用真 setTimeout 接管 rAF
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => realTimeout(() => cb(performance.now()), 16) as unknown as number);
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => realClear(id as unknown as ReturnType<typeof setTimeout>));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const m = mount([]);
    expect(screen.queryByTestId('sync-notice-hard-deleted')).toBeNull();
    act(() => m.set({ hardDeleted: 1 }));
    expect(screen.getByTestId('sync-notice-hard-deleted').textContent).toBe('这条已彻底删除，无法恢复。');
    // 假的是 setTimeout，waitFor 轮询用不了；jsdom 的 requestAnimationFrame 用自己的真计时器：用真 setTimeout 每 20ms 看一次，最多 2 秒
    await act(async () => {
      for (let i = 0; i < 100 && m.live.textContent === ''; i++) await new Promise<void>((ok) => realTimeout(ok, 20));
    });
    expect(m.live.textContent).toBe('这条已彻底删除，无法恢复。');
    act(() => uiStore.getState().setLocale('ko-KR'));   // 中途换界面语言（t 换了身份）：计时不丢，照样到点消失
    act(() => vi.advanceTimersByTime(8_100));
    vi.useRealTimers();
    await waitFor(() => expect(screen.queryByTestId('sync-notice-hard-deleted')).toBeNull());
    raf.mockRestore();
    caf.mockRestore();
  });
});
