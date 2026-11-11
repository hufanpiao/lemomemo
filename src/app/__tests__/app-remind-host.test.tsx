// App 挂提醒（REMIND-wiring）：挂一份、按 user_id 作 key、整页提醒立刻挂、出错和分包没到不挡页面；首屏减重 ⑥ 画完、空闲以后才挂、since；
// 接线审查⑥ M1（页面没提交不等空闲、出错页照常触发首屏判断）、REMIND-arm-firstpaint（root-paint 自己的时限）
// 替身和复位在 app-remind-host-fixture.tsx（必须第一个 import）
import { App, clock, frameQ, idleQ, life, pageThenIdle, runFrame, runIdle, setLogSink, setTodayPage, settle, st, startAppPaintLimit } from './app-remind-host-fixture.tsx';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { remindQueue, setRemindArmed, setRemindDown } from '../../kit/state/remind-queue.ts';
import { remindArmWatchdog } from '../App.tsx';

// 挂整个 App：全量跑、机器忙时默认 5 秒不够
vi.setConfig({ testTimeout: 15_000 });
afterEach(() => {
  setRemindDown(false);
  setRemindArmed(null);
});

describe('App 挂提醒', () => {
  it('没启动（没有会话）：不挂 RemindHost', async () => {
    render(<App />);
    await screen.findByRole('main', {}, { timeout: 10_000 });
    expect(screen.queryByTestId('fake-host')).toBeNull();
  });

  it('按 user_id 作 key：换账号整个重新挂载（L8），同一个账号换页不重挂', async () => {
    st.userId = 'user-a';
    const now = vi.spyOn(clock, 'now').mockReturnValue(1_800_000_000_000);
    const { rerender } = render(<App />);
    await pageThenIdle();
    expect((await screen.findByTestId('fake-host', {}, { timeout: 10_000 })).getAttribute('data-since')).toBe('1800000000000');
    await act(async () => {
      window.location.hash = '#/notes';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(life).toEqual(['mount:user-a:today']);
    st.userId = 'user-b';
    now.mockReturnValue(1_800_000_060_000);
    rerender(<App />);
    // 换账号时 remindReady 已是 true，新 key 立刻重挂；waitFor 只是等 effect 跑完
    await waitFor(() => expect(life).toEqual(['mount:user-a:today', 'unmount:user-a', 'mount:user-b:notes']), { timeout: 10_000 });
    // since 按账号重记（接线审查⑥ L2）：新账号的是换账号那一刻
    expect(screen.getByTestId('fake-host').getAttribute('data-since')).toBe('1800000060000');
  });

  it('#/remind/event/<id>?due=<dueAt>（冷启动点系统通知进来）：进整页提醒，不等空闲立刻挂，RemindHost 拿到的路由是 remind', async () => {
    st.userId = 'user-a';
    window.location.hash = '#/remind/event/00000000-0000-4000-8000-000000000001?due=1800000000000';
    render(<App />);
    const page = await screen.findByRole('main', {}, { timeout: 10_000 });
    expect(page.getAttribute('data-feature')).toBe('remind');
    expect((await screen.findByTestId('fake-host')).getAttribute('data-route')).toBe('remind');
    // 没排等空闲
    expect(idleQ).toHaveLength(0);
  });
  it('RemindHost 出错（R5、R2）：页面照常，提醒这一块不画，记一条日志', async () => {
    st.userId = 'user-a';
    st.hostMode = 'throw';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const errors: unknown[] = [];
    setLogSink((act, f) => void (act === 'js_error' && errors.push(f?.error)));
    render(<App />);
    const page = await pageThenIdle();
    expect(page.getAttribute('data-feature')).toBe('today');
    await waitFor(() => expect(errors).toHaveLength(1));
    expect((errors[0] as Error).message).toBe('remind host boom');
    expect(screen.queryByTestId('fake-host')).toBeNull();
    expect(screen.queryByTestId('app-error')).toBeNull();
  });

  it('RemindHost 出错：记进 kit 的 remindDown（今天页照样挂“错过的提醒”，今天页待办 代码审查 M1）；换账号那一份卸载时清掉、新账号重新试', async () => {
    st.userId = 'user-a';
    st.hostMode = 'throw';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender } = render(<App />);
    await pageThenIdle();
    await waitFor(() => expect(remindQueue.getState().remindDown).toBe(true));
    st.userId = 'user-b';
    st.hostMode = 'ok';
    rerender(<App />);
    expect(await screen.findByTestId('fake-host', {}, { timeout: 10_000 })).toBeTruthy();
    expect(remindQueue.getState().remindDown).toBe(false);
  });

  it('提醒分包一直没到（R5）：页面照常画出来，提醒不先画、也不挡页面', async () => {
    st.userId = 'user-a';
    st.hostMode = 'pending';
    render(<App />);
    const page = await pageThenIdle();
    expect(page.getAttribute('data-feature')).toBe('today');
    expect(screen.queryByTestId('fake-host')).toBeNull();
  });

  // 审查“错过提醒推迟挂载”M1：今天页等 armed 才挂“错过的提醒”，引擎一直不 armed 又不报错时，看门狗到点写 remindDown
  it('看门狗：分包一直没到，挂上（ready）以后 15 秒还没 armed → remindDown（今天页照样挂“错过的提醒”）；之后 armed 了清掉', async () => {
    const fires: Array<() => void> = [];
    vi.spyOn(remindArmWatchdog, 'start').mockImplementation((fn) => (fires.push(fn), 0 as unknown as ReturnType<typeof setTimeout>));
    st.userId = 'user-a';
    st.hostMode = 'pending';
    render(<App />);
    expect(fires).toHaveLength(0); // ready 之前不起表（复审 N2）
    await pageThenIdle();
    await waitFor(() => expect(fires).toHaveLength(1)); // ready 以后才起
    expect(remindQueue.getState().remindDown).toBe(false);
    act(() => fires[0]?.());
    expect(remindQueue.getState().remindDown).toBe(true);
    act(() => setRemindArmed(1));
    expect(remindQueue.getState().remindDown).toBe(false);
  });

  it('看门狗：时限内 armed 了就停表，到点也不写 remindDown；出错写的 remindDown 不归看门狗清', async () => {
    const fires: Array<() => void> = [];
    const stop = vi.spyOn(remindArmWatchdog, 'stop');
    vi.spyOn(remindArmWatchdog, 'start').mockImplementation((fn) => (fires.push(fn), 7 as unknown as ReturnType<typeof setTimeout>));
    st.userId = 'user-a';
    st.hostMode = 'pending';
    render(<App />);
    await pageThenIdle();
    await waitFor(() => expect(fires).toHaveLength(1));
    act(() => setRemindArmed(1));
    expect(stop).toHaveBeenCalledWith(7);
    act(() => fires[0]?.());
    expect(remindQueue.getState().remindDown).toBe(false);
    act(() => setRemindDown(true)); // 比如之后渲染出错（App 的错误边界写）
    act(() => setRemindArmed(2));
    expect(remindQueue.getState().remindDown).toBe(true);
  });

  it('首屏减重 ⑥：页面画出来以后才开始等空闲，空闲之前不挂 RemindHost，空闲了才挂', async () => {
    st.userId = 'user-a';
    render(<App />);
    const page = await screen.findByRole('main', {}, { timeout: 10_000 });
    expect(page.getAttribute('data-feature')).toBe('today');
    // 页面出来了、那一帧还没过：首屏还没画完，不排等空闲、不挂
    await waitFor(() => expect(frameQ).toHaveLength(1), { timeout: 10_000 });
    await settle();
    expect(idleQ).toHaveLength(0);
    expect(screen.queryByTestId('fake-host')).toBeNull();
    runFrame();
    await waitFor(() => expect(idleQ).toHaveLength(1), { timeout: 10_000 });
    expect(screen.queryByTestId('fake-host')).toBeNull();
    expect(life).toEqual([]);
    runIdle();
    await screen.findByTestId('fake-host', {}, { timeout: 10_000 });
    expect(life).toEqual(['mount:user-a:today']);
    // 挂上以后不再排等空闲
    expect(idleQ).toHaveLength(0);
  });

  it('首屏减重 ⑥：since 是 App 第一次渲染的时刻，不是空闲后挂上的时刻', async () => {
    st.userId = 'user-a';
    const now = vi.spyOn(clock, 'now').mockReturnValue(1_800_000_000_000);
    render(<App />);
    await screen.findByRole('main', {}, { timeout: 10_000 });
    await waitFor(() => expect(frameQ).toHaveLength(1), { timeout: 10_000 });
    runFrame();
    await waitFor(() => expect(idleQ).toHaveLength(1), { timeout: 10_000 });
    now.mockReturnValue(1_800_000_002_000);
    runIdle();
    const host = await screen.findByTestId('fake-host', {}, { timeout: 10_000 });
    expect(host.getAttribute('data-since')).toBe('1800000000000');
  });
  it('M1 (a)：页面分包还没到（页面没提交）时不开始等空闲、不挂提醒；到了、提交了才排等空闲', async () => {
    st.userId = 'user-a';
    setTodayPage('pending');
    render(<App />);
    await settle();
    expect(screen.queryByRole('main')).toBeNull();
    expect(frameQ).toHaveLength(0);
    expect(idleQ).toHaveLength(0);
    expect(screen.queryByTestId('fake-host')).toBeNull();
    await act(async () => {
      st.releasePage();
    });
    await screen.findByRole('main', {}, { timeout: 10_000 });
    await waitFor(() => expect(frameQ).toHaveLength(1), { timeout: 10_000 });
    runFrame();
    await waitFor(() => expect(idleQ).toHaveLength(1), { timeout: 10_000 });
    expect(screen.queryByTestId('fake-host')).toBeNull();
  });

  it('M1 (b)（FIRSTPAINT-nofeature 后）：页面分包加载失败显示 ErrorView，根是 main[data-feature="error"]，首屏判断照常触发，不用等硬上限', async () => {
    st.userId = 'user-a';
    setTodayPage('reject');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<App />);
    const err = await screen.findByTestId('app-error', {}, { timeout: 10_000 });
    expect(err.closest('main')?.getAttribute('data-feature')).toBe('error');
    await waitFor(() => expect(frameQ).toHaveLength(1), { timeout: 10_000 });
    runFrame();
    await waitFor(() => expect(idleQ).toHaveLength(1), { timeout: 10_000 });
    expect(screen.queryByTestId('fake-host')).toBeNull();
    runIdle();
    await screen.findByTestId('fake-host', {}, { timeout: 10_000 });
  });

  it('REMIND-arm-firstpaint：root-paint 自己的时限（render 后 startAppPaintLimit）到了也算画完，排等空闲、空闲后挂', async () => {
    st.userId = 'user-a';
    setTodayPage('pending');
    render(<App />);
    startAppPaintLimit(20);
    await settle();
    await waitFor(() => expect(idleQ).toHaveLength(1), { timeout: 10_000 });
    // 页面还是没出来，那一帧也没排
    expect(screen.queryByRole('main')).toBeNull();
    expect(frameQ).toHaveLength(0);
    expect(screen.queryByTestId('fake-host')).toBeNull();
    runIdle();
    await screen.findByTestId('fake-host', {}, { timeout: 10_000 });
  });
});
