// app-remind-host*.test.tsx 共用的替身和小工具（原来都写在 app-remind-host.test.tsx 里，超过 300 行拆成两份，代码复审第二轮 N6）。
// 用法：测试文件第一行 import 这个文件（vi.mock 在这里登记，App 等模块在这里用 await import 拿到，这样替身先于它们生效）；
// 每条测试之前、之后的复位也在这里（beforeEach / afterEach 注册到 import 它的那个测试文件）。可变的状态放在 st 上（userId、hostMode、releasePage）
// —— 下面是原来那份的说明 ——
// App 挂提醒（REMIND-wiring）：RemindHost 挂一份、按登录会话的 user_id 作 key（换账号重新挂载，L8）；
// 没启动（没有会话）不挂；#/remind/<kind>/<id>?due= 进整页提醒，RemindHost 拿到的路由是 'remind'
// 首屏减重 ⑥：页面画出来、浏览器空闲（whenIdle，这里换成手动放行）以后才挂；冷启动就是整页提醒时立刻挂；since 是 App 第一次渲染的时刻
// 复审补（接线审查⑥ M1、L2、L3）：页面分包没到时不开始等空闲；页面分包加载失败（ErrorView）照样挂；换账号 since 重记；
// 和页面无关的硬上限 REMIND_MAX_WAIT_MS（这里截下那一个定时器手动放行）
// today 页换成可控的 lazy：正常、一直挂着（手动放行）、加载失败
// REMIND-arm-firstpaint：“首屏画完”改用 platform/root-paint.ts（和同步同一套）。这里用真的 root-paint：在 document.body 上挂 watchRoot，
// “再过一帧”换成手动放行（runFrame）；页面（<main>）出来、过了那一帧才算画完，然后才排等空闲
// REMIND-arm-low：L1 App 第一次渲染时 root-paint 已经算画完（告知页之后、入口没挂 watchRoot）就另外等 App 自己的功能页；
// L3 cancelled：App 卸载以后放行 root-paint，不再排等空闲（拦变异 Y4）
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { afterEach, beforeEach, expect, vi } from 'vitest';

// 挂整个 App：全量跑、机器忙时默认 5 秒不够（c8b5596 CI，写法同 cal-same-page.test.tsx、App.test.tsx）
vi.setConfig({ testTimeout: 15_000 });

export const life: string[] = [];
/** 每条测试会改的状态：登录的 user_id（null 是没启动）、提醒分包怎么样、放行一直挂着的页面分包 */
export const st: { userId: string | null; hostMode: 'ok' | 'throw' | 'pending'; releasePage: () => void } = {
  userId: null,
  hostMode: 'ok',
  releasePage: () => undefined,
};
vi.mock('../../core/boot.ts', () => ({ getBoot: () => (st.userId === null ? null : { userId: st.userId }) }));
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
export function setTodayPage(mode: 'ok' | 'pending' | 'reject'): void {
  todayPage.current =
    mode === 'ok'
      ? lazy(async () => ({ default: TodayMain }))
      : mode === 'pending'
        ? lazy(() => new Promise<{ default: ComponentType }>((res) => {
          st.releasePage = () => res({ default: TodayMain });
        }))
        : lazy(() => Promise.reject(new Error('page chunk failed')));
}
/** 等空闲的回调：测试里手动放行（runIdle） */
export const idleQ: (() => void)[] = [];
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
      const who = st.userId;
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
    if (st.hostMode === 'throw') throw new Error('remind host boom');
    if (st.hostMode === 'pending') return <PendingHost />;
    return <FakeHost route={route} since={since} />;
  }
  return {
    // features.ts 把整个模块当登记项（不受开关管，没有 flag）
    flag: undefined,
    routes: [{ name: 'remind', Page: React.lazy(async () => ({ default: () => <main data-feature="remind" /> })) }],
    RemindHost: Host,
  };
});

export const { App, REMIND_MAX_WAIT_MS, remindMaxWait } = await import('../App.tsx');
export const { resetLogBusForTest, setLogSink } = await import('../../../shared/core/log-bus.ts');
export const { resetRootPaintForTest, startAppPaintLimit, watchRoot } = await import('../../platform/root-paint.ts');

/** root-paint 的“再过一帧”：截下来手动放行 */
export const frameQ: (() => void)[] = [];
const frame = (fn: () => void): (() => void) => {
  frameQ.push(fn);
  return () => undefined;
};
export const runFrame = () => act(() => {
  for (const f of frameQ.splice(0)) f();
});
let unwatch: () => void = () => undefined;
/** 停掉 beforeEach 挂的 watchRoot（测“入口没挂 watchRoot”时用） */
export function stopWatch(): void {
  unwatch();
}
export const { clock } = await import('../../platform/clock.ts');

/** 硬上限的定时器（App 的 remindMaxWait）：spy 它，截下回调手动放行；stopped 记下被取消的编号 */
export const capQ: (() => void)[] = [];
export const stopped: unknown[] = [];
/** 截下的那个定时器的编号 */
export const CAP_ID = 987_654 as unknown as ReturnType<typeof setTimeout>;
export const runCap = () => act(() => {
  for (const f of capQ.splice(0)) f();
});
/** 排两轮宏任务，让已经能跑的都跑完 */
export const settle = () => act(async () => {
  for (let i = 0; i < 2; i++) await new Promise<void>((r) => setTimeout(r, 0));
});

/** 浏览器空闲了：放行排着的回调 */
export const runIdle = () => act(() => {
  for (const f of idleQ.splice(0)) f();
});
/** 页面画出来、过了那一帧（首屏画完），再放行空闲 */
export async function pageThenIdle() {
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
  resetRootPaintForTest();
  // 和入口（main.tsx）一样在 render 之前挂上；长兜底给大，这里不让它自己到点
  unwatch = watchRoot(document.body, frame, 600_000);
  st.userId = null;
  st.hostMode = 'ok';
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
  resetRootPaintForTest();
  resetLogBusForTest();
  vi.restoreAllMocks();
  window.location.hash = '';
});

