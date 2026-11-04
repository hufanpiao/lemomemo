// App 挂提醒（REMIND-wiring）：RemindHost 挂一份、按登录会话的 user_id 作 key（换账号重新挂载，L8）；
// 没启动（没有会话）不挂；#/remind/<kind>/<id>?due= 进整页提醒，RemindHost 拿到的路由是 'remind'
// 首屏减重 ⑥：页面画出来、浏览器空闲（whenIdle，这里换成手动放行）以后才挂；冷启动就是整页提醒时立刻挂；since 是 App 第一次渲染的时刻
// 复审补（接线审查⑥ M1、L2、L3）：页面分包没到时不开始等空闲；页面分包加载失败（ErrorView）照样挂；换账号 since 重记；
// 和页面无关的硬上限 REMIND_MAX_WAIT_MS（这里截下那一个定时器手动放行）
// today 页换成可控的 lazy：正常、一直挂着（手动放行）、加载失败
// REMIND-arm-firstpaint：“首屏画完”改用 platform/first-paint.ts（和同步同一套）。这里用真的 first-paint：在 document.body 上挂 watchAppPainted，
// “再过一帧”换成手动放行（runFrame）；页面（main[data-feature]）出来、过了那一帧才算画完，然后才排等空闲
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 挂整个 App：全量跑、机器忙时默认 5 秒不够（c8b5596 CI，写法同 cal-same-page.test.tsx、App.test.tsx）
vi.setConfig({ testTimeout: 15_000 });

const life: string[] = [];
let userId: string | null = null;
let hostMode: 'ok' | 'throw' | 'pending' = 'ok';
vi.mock('../../core/boot.ts', () => ({ getBoot: () => (userId === null ? null : { userId }) }));
vi.mock('../UpdateBanner.tsx', () => ({ UpdateBanner: () => null }));
/** today 页：每条测试换一个新的 lazy（lazy 会记住结果，不能跨测试共用） */
const todayPage: { current: LazyExoticComponent<ComponentType> | null } = { current: null };
vi.mock('../../features/today/index.ts', () => {
  function TodayPage() {
    const L = todayPage.current;
    return L ? <L /> : null;
  }
  return { flag: undefined, routes: [{ name: 'today', Page: TodayPage }] };
});
const TodayMain = () => <main data-feature="today" />;
let releasePage: () => void = () => undefined;
function setTodayPage(mode: 'ok' | 'pending' | 'reject'): void {
  todayPage.current =
    mode === 'ok'
      ? lazy(async () => ({ default: TodayMain }))
      : mode === 'pending'
        ? lazy(() => new Promise<{ default: ComponentType }>((res) => {
          releasePage = () => res({ default: TodayMain });
        }))
        : lazy(() => Promise.reject(new Error('page chunk failed')));
}
/** 等空闲的回调：测试里手动放行（runIdle） */
const idleQ: (() => void)[] = [];
vi.mock('../../platform/session.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  whenIdle: (fn: () => void) => {
    idleQ.push(fn);
  },
}));
vi.mock('../../features/reminders/index.ts', async () => {
  const React = await import('react');
  function FakeHost({ route, since }: { route?: string | undefined; since?: number | undefined }) {
    // 只记挂载、卸载（带挂载时的路由）；route 变了不算
    const firstRoute = React.useRef(route);
    React.useEffect(() => {
      const who = userId;
      life.push(`mount:${who}:${String(firstRoute.current)}`);
      return () => {
        life.push(`unmount:${who}`);
      };
    }, []);
    return <div data-testid="fake-host" data-route={route} data-since={since} />;
  }
  // 提醒分包一直没到（接线审查 R5）
  const PendingHost = React.lazy(() => new Promise<never>(() => undefined));
  function Host({ route, since }: { route?: string; since?: number }) {
    if (hostMode === 'throw') throw new Error('remind host boom');
    if (hostMode === 'pending') return <PendingHost />;
    return <FakeHost route={route} since={since} />;
  }
  return {
    // features.ts 把整个模块当登记项（不受开关管，没有 flag）
    flag: undefined,
    routes: [{ name: 'remind', Page: React.lazy(async () => ({ default: () => <main data-feature="remind" /> })) }],
    RemindHost: Host,
  };
});

const { App, REMIND_MAX_WAIT_MS, remindMaxWait, setRemindErrorLog } = await import('../App.tsx');
const { resetAppPaintedForTest, startAppPaintLimit, watchAppPainted } = await import('../../platform/first-paint.ts');

/** first-paint 的“再过一帧”：截下来手动放行 */
const frameQ: (() => void)[] = [];
const frame = (fn: () => void): (() => void) => {
  frameQ.push(fn);
  return () => undefined;
};
const runFrame = () => act(() => {
  for (const f of frameQ.splice(0)) f();
});
let unwatch: () => void = () => undefined;
const { clock } = await import('../../platform/clock.ts');

/** 硬上限的定时器（App 的 remindMaxWait）：spy 它，截下回调手动放行；stopped 记下被取消的编号 */
const capQ: (() => void)[] = [];
const stopped: unknown[] = [];
/** 截下的那个定时器的编号 */
const CAP_ID = 987_654 as unknown as ReturnType<typeof setTimeout>;
const runCap = () => act(() => {
  for (const f of capQ.splice(0)) f();
});
/** 排两轮宏任务，让已经能跑的都跑完 */
const settle = () => act(async () => {
  for (let i = 0; i < 2; i++) await new Promise<void>((r) => setTimeout(r, 0));
});

/** 浏览器空闲了：放行排着的回调 */
const runIdle = () => act(() => {
  for (const f of idleQ.splice(0)) f();
});
/** 页面画出来、过了那一帧（首屏画完），再放行空闲 */
async function pageThenIdle() {
  const page = await screen.findByRole('main', {}, { timeout: 10_000 });
  await waitFor(() => expect(frameQ).toHaveLength(1), { timeout: 10_000 });
  runFrame();
  await waitFor(() => expect(idleQ).toHaveLength(1), { timeout: 10_000 });
  runIdle();
  return page;
}

beforeEach(() => {
  life.length = 0;
  idleQ.length = 0;
  capQ.length = 0;
  stopped.length = 0;
  frameQ.length = 0;
  resetAppPaintedForTest();
  // 和入口（main.tsx）一样在 render 之前挂上；长兜底给大，这里不让它自己到点
  unwatch = watchAppPainted(document.body, frame, 600_000);
  userId = null;
  hostMode = 'ok';
  setTodayPage('ok');
  vi.spyOn(remindMaxWait, 'start').mockImplementation((fn) => {
    capQ.push(fn);
    return CAP_ID;
  });
  vi.spyOn(remindMaxWait, 'stop').mockImplementation((id) => {
    stopped.push(id);
  });
});
afterEach(() => {
  cleanup();
  unwatch();
  resetAppPaintedForTest();
  setRemindErrorLog(null);
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('App 挂提醒', () => {
  it('没启动（没有会话）：不挂 RemindHost', async () => {
    render(<App />);
    await screen.findByRole('main', {}, { timeout: 10_000 });
    expect(screen.queryByTestId('fake-host')).toBeNull();
  });

  it('按 user_id 作 key：换账号整个重新挂载（L8），同一个账号换页不重挂', async () => {
    userId = 'user-a';
    const now = vi.spyOn(clock, 'now').mockReturnValue(1_800_000_000_000);
    const { rerender } = render(<App />);
    await pageThenIdle();
    expect((await screen.findByTestId('fake-host', {}, { timeout: 10_000 })).getAttribute('data-since')).toBe('1800000000000');
    await act(async () => {
      window.location.hash = '#/notes';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(life).toEqual(['mount:user-a:today']);
    userId = 'user-b';
    now.mockReturnValue(1_800_000_060_000);
    rerender(<App />);
    // 换账号时 remindReady 已是 true，新 key 立刻重挂；waitFor 只是等 effect 跑完
    await waitFor(() => expect(life).toEqual(['mount:user-a:today', 'unmount:user-a', 'mount:user-b:notes']), { timeout: 10_000 });
    // since 按账号重记（接线审查⑥ L2）：新账号的是换账号那一刻
    expect(screen.getByTestId('fake-host').getAttribute('data-since')).toBe('1800000060000');
  });

  it('#/remind/event/<id>?due=<dueAt>（冷启动点系统通知进来）：进整页提醒，不等空闲立刻挂，RemindHost 拿到的路由是 remind', async () => {
    userId = 'user-a';
    window.location.hash = '#/remind/event/00000000-0000-4000-8000-000000000001?due=1800000000000';
    render(<App />);
    const page = await screen.findByRole('main', {}, { timeout: 10_000 });
    expect(page.getAttribute('data-feature')).toBe('remind');
    expect((await screen.findByTestId('fake-host')).getAttribute('data-route')).toBe('remind');
    // 没排等空闲
    expect(idleQ).toHaveLength(0);
  });
  it('RemindHost 出错（R5、R2）：页面照常，提醒这一块不画，记一条日志', async () => {
    userId = 'user-a';
    hostMode = 'throw';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const errors: unknown[] = [];
    setRemindErrorLog((e) => errors.push(e));
    render(<App />);
    const page = await pageThenIdle();
    expect(page.getAttribute('data-feature')).toBe('today');
    await waitFor(() => expect(errors).toHaveLength(1));
    expect((errors[0] as Error).message).toBe('remind host boom');
    expect(screen.queryByTestId('fake-host')).toBeNull();
    expect(screen.queryByTestId('app-error')).toBeNull();
  });

  it('提醒分包一直没到（R5）：页面照常画出来，提醒不先画、也不挡页面', async () => {
    userId = 'user-a';
    hostMode = 'pending';
    render(<App />);
    const page = await pageThenIdle();
    expect(page.getAttribute('data-feature')).toBe('today');
    expect(screen.queryByTestId('fake-host')).toBeNull();
  });
  it('首屏减重 ⑥：页面画出来以后才开始等空闲，空闲之前不挂 RemindHost，空闲了才挂', async () => {
    userId = 'user-a';
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
    userId = 'user-a';
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
    userId = 'user-a';
    setTodayPage('pending');
    render(<App />);
    await settle();
    expect(screen.queryByRole('main')).toBeNull();
    expect(frameQ).toHaveLength(0);
    expect(idleQ).toHaveLength(0);
    expect(screen.queryByTestId('fake-host')).toBeNull();
    await act(async () => {
      releasePage();
    });
    await screen.findByRole('main', {}, { timeout: 10_000 });
    await waitFor(() => expect(frameQ).toHaveLength(1), { timeout: 10_000 });
    runFrame();
    await waitFor(() => expect(idleQ).toHaveLength(1), { timeout: 10_000 });
    expect(screen.queryByTestId('fake-host')).toBeNull();
  });

  it('M1 (b)：页面分包加载失败（显示 ErrorView，没有 main[data-feature]）：不算画完，靠兜底挂上——提醒的硬上限到了就挂', async () => {
    userId = 'user-a';
    setTodayPage('reject');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<App />);
    await screen.findByTestId('app-error', {}, { timeout: 10_000 });
    await settle();
    expect(frameQ).toHaveLength(0);
    expect(idleQ).toHaveLength(0);
    expect(screen.queryByTestId('fake-host')).toBeNull();
    runCap();
    await screen.findByTestId('fake-host', {}, { timeout: 10_000 });
  });

  it('REMIND-arm-firstpaint：first-paint 自己的时限（render 后 startAppPaintLimit）到了也算画完，排等空闲、空闲后挂', async () => {
    userId = 'user-a';
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

  it('REMIND-arm-firstpaint：入口没挂 watchAppPainted（测试、别的入口）时当场算画完，挂上就排等空闲', async () => {
    unwatch();
    resetAppPaintedForTest();
    userId = 'user-a';
    setTodayPage('pending');
    render(<App />);
    await waitFor(() => expect(idleQ).toHaveLength(1), { timeout: 10_000 });
    runIdle();
    await screen.findByTestId('fake-host', {}, { timeout: 10_000 });
  });

  it('L3：页面一直不提交也有硬上限：REMIND_MAX_WAIT_MS 一到就挂上提醒（从 App 第一次渲染算起）', async () => {
    userId = 'user-a';
    setTodayPage('pending');
    render(<App />);
    await settle();
    expect(REMIND_MAX_WAIT_MS).toBe(5000);
    expect(capQ).toHaveLength(1);
    expect(idleQ).toHaveLength(0);
    expect(screen.queryByTestId('fake-host')).toBeNull();
    runCap();
    await screen.findByTestId('fake-host', {}, { timeout: 10_000 });
    // 页面还是没画出来
    expect(screen.queryByRole('main')).toBeNull();
  });

  it('L3：空闲先到、已经挂上了，硬上限的定时器取消（不重复挂）', async () => {
    userId = 'user-a';
    render(<App />);
    await pageThenIdle();
    await screen.findByTestId('fake-host', {}, { timeout: 10_000 });
    expect(stopped).toEqual([CAP_ID]);
    runCap();
    expect(life).toEqual(['mount:user-a:today']);
  });
  it('N1：页面一直不提交时切页，硬上限不重新计时（还是那一个定时器，没被取消）', async () => {
    userId = 'user-a';
    setTodayPage('pending');
    render(<App />);
    await settle();
    expect(capQ).toHaveLength(1);
    await act(async () => {
      window.location.hash = '#/notes';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await settle();
    expect(capQ).toHaveLength(1);
    expect(stopped).toEqual([]);
    runCap();
    await screen.findByTestId('fake-host', {}, { timeout: 10_000 });
  });
});
