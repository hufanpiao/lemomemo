// App 挂提醒（REMIND-wiring）：RemindHost 挂一份、按登录会话的 user_id 作 key（换账号重新挂载，L8）；
// 没启动（没有会话）不挂；#/remind/<kind>/<id>?due= 进整页提醒，RemindHost 拿到的路由是 'remind'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 挂整个 App：全量跑、机器忙时默认 5 秒不够（c8b5596 CI，写法同 cal-same-page.test.tsx、App.test.tsx）
vi.setConfig({ testTimeout: 15_000 });

const life: string[] = [];
let userId: string | null = null;
let hostMode: 'ok' | 'throw' | 'pending' = 'ok';
vi.mock('../../core/boot.ts', () => ({ getBoot: () => (userId === null ? null : { userId }) }));
vi.mock('../UpdateBanner.tsx', () => ({ UpdateBanner: () => null }));
vi.mock('../../features/reminders/index.ts', async () => {
  const React = await import('react');
  function FakeHost({ route }: { route?: string | undefined }) {
    // 只记挂载、卸载（带挂载时的路由）；route 变了不算
    const firstRoute = React.useRef(route);
    React.useEffect(() => {
      const who = userId;
      life.push(`mount:${who}:${String(firstRoute.current)}`);
      return () => {
        life.push(`unmount:${who}`);
      };
    }, []);
    return <div data-testid="fake-host" data-route={route} />;
  }
  // 提醒分包一直没到（接线审查 R5）
  const PendingHost = React.lazy(() => new Promise<never>(() => undefined));
  function Host({ route }: { route?: string }) {
    if (hostMode === 'throw') throw new Error('remind host boom');
    if (hostMode === 'pending') return <PendingHost />;
    return <FakeHost route={route} />;
  }
  return {
    // features.ts 把整个模块当登记项（不受开关管，没有 flag）
    flag: undefined,
    routes: [{ name: 'remind', Page: React.lazy(async () => ({ default: () => <main data-feature="remind" /> })) }],
    RemindHost: Host,
  };
});

const { App, setRemindErrorLog } = await import('../App.tsx');

beforeEach(() => {
  life.length = 0;
  userId = null;
  hostMode = 'ok';
});
afterEach(() => {
  cleanup();
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
    const { rerender } = render(<App />);
    await screen.findByTestId('fake-host', {}, { timeout: 10_000 });
    await act(async () => {
      window.location.hash = '#/notes';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(life).toEqual(['mount:user-a:today']);
    userId = 'user-b';
    rerender(<App />);
    // 页面分包（notes）没到时外层 Suspense 会把这次提交往后推，等它到
    await waitFor(() => expect(life).toEqual(['mount:user-a:today', 'unmount:user-a', 'mount:user-b:notes']), { timeout: 10_000 });
  });

  it('#/remind/event/<id>?due=<dueAt>：进整页提醒，RemindHost 拿到的路由是 remind', async () => {
    userId = 'user-a';
    window.location.hash = '#/remind/event/00000000-0000-4000-8000-000000000001?due=1800000000000';
    render(<App />);
    const page = await screen.findByRole('main', {}, { timeout: 10_000 });
    expect(page.getAttribute('data-feature')).toBe('remind');
    expect(screen.getByTestId('fake-host').getAttribute('data-route')).toBe('remind');
  });
  it('RemindHost 出错（R5、R2）：页面照常，提醒这一块不画，记一条日志', async () => {
    userId = 'user-a';
    hostMode = 'throw';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const errors: unknown[] = [];
    setRemindErrorLog((e) => errors.push(e));
    render(<App />);
    const page = await screen.findByRole('main', {}, { timeout: 10_000 });
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
    const page = await screen.findByRole('main', {}, { timeout: 10_000 });
    expect(page.getAttribute('data-feature')).toBe('today');
    expect(screen.queryByTestId('fake-host')).toBeNull();
  });
});
