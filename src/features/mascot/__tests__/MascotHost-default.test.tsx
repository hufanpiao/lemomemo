// 今天页挂哪一只（负责人 11-26“我默认是二号，其他人是aldo”）：
// 没选过时要等管理员身份读到才挂，不能先挂 Aldo 再换成 #2；读到普通账号挂 Aldo，管理员挂 #2；选过的不等也不变
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mascotValue, MASCOT_KEY } from '../data/mascot-setting.ts';
import { mascotSession, resetMascotSession } from '../hooks/mascot-session.ts';
import MascotHost from '../ui/MascotHost.tsx';
import { stageId } from './stage-id.ts';

const h = vi.hoisted(() => ({ admin: null as boolean | null, rows: [] as Record<string, unknown>[], ids: [] as string[], route: 'today', ready: false, destroyed: 0 }));

vi.mock('../../../app/router.ts', () => ({ useRoute: () => ({ name: h.route }) }));
vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: (name: string) => (name === 'settings' ? h.rows : []) }));
vi.mock('../hooks/useMascotAdmin.ts', () => ({ useMascotAdmin: () => h.admin }));
vi.mock('../../../platform/run-log-api.ts', () => ({ rlog: vi.fn(), RLOG_ON: false }));
vi.mock('../../ai-chat/index.ts', () => ({ loadChatOpen: vi.fn() }));
vi.mock('../hooks/gesture.ts', () => ({ watchGesture: () => () => undefined, cardClipPath: () => '', overClipPath: () => '', inCardClip: () => false }));
vi.mock('../hooks/stage.ts', () => ({
  createStage: (_el: HTMLElement, def: { url: string }) => {
    h.ids.push(stageId(def));
    const destroy = (): void => {
      h.destroyed += 1;
    };
    return { ready: h.ready, react: vi.fn(), flag: vi.fn(), destroy, lookAt: vi.fn(), opaqueAt: () => false, setBool: vi.fn() };
  },
}));

beforeEach(() => {
  resetMascotSession();
  h.admin = null;
  h.rows = [];
  h.ids = [];
  h.route = 'today';
  h.ready = false;
  h.destroyed = 0;
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  const card = document.createElement('div');
  card.dataset['testid'] = 'now-card';
  Object.defineProperty(card, 'offsetWidth', { value: 400 });
  document.body.appendChild(card);
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('今天页吉祥物的默认', () => {
  it('没选过、管理员身份还没读到：一只都不挂（不会先出 Aldo 再换）；读到管理员挂 #2', () => {
    const v = render(<MascotHost />);
    expect(h.ids).toEqual([]);
    expect(document.querySelector('[data-testid="mascot"]')).toBeNull();
    h.admin = true;
    act(() => v.rerender(<MascotHost />));
    expect(h.ids).toEqual(['2']);
  });

  it('没选过、读到普通账号：挂 Aldo #23', () => {
    const v = render(<MascotHost />);
    h.admin = false;
    act(() => v.rerender(<MascotHost />));
    expect(h.ids).toEqual(['23']);
  });

  it('管理员冷启动 2 秒没读到身份：先挂 Aldo，读到是管理员再换成 #2', () => {
    const v = render(<MascotHost />);
    h.admin = false;
    act(() => v.rerender(<MascotHost />));
    h.admin = true;
    act(() => v.rerender(<MascotHost />));
    expect(h.ids).toEqual(['23', '2']);
  });

  it('选过公开角色：不等管理员身份，直接挂选的那只', () => {
    h.rows = [{ id: 'k', key: MASCOT_KEY, value: mascotValue('19') }];
    render(<MascotHost />);
    expect(h.ids).toEqual(['19']);
  });
});

describe('留着的舞台（这次打开的会话对象 mascotSession.kept）', () => {
  it('进二级页再回今天页：同一只接回原来的舞台，不重建、不销毁，层接到卡片后面', () => {
    h.rows = [{ id: 'k', key: MASCOT_KEY, value: mascotValue('19') }];
    h.ready = true;
    const v = render(<MascotHost />);
    const layer = document.querySelector('[data-testid="mascot"]');
    expect(layer).not.toBeNull();
    h.route = 'settings';
    act(() => v.rerender(<MascotHost />));
    expect(document.querySelector('[data-testid="mascot"]')).toBeNull();
    expect(mascotSession.kept?.id).toBe('19');
    h.route = 'today';
    act(() => v.rerender(<MascotHost />));
    expect(h.ids).toEqual(['19']);
    expect(h.destroyed).toBe(0);
    expect(document.querySelector('[data-testid="mascot"]')).toBe(layer);
    expect(layer?.previousElementSibling?.getAttribute('data-testid')).toBe('now-card');
  });

  it('回来时换了一只：留着的那份销毁，新建选的那只', () => {
    h.rows = [{ id: 'k', key: MASCOT_KEY, value: mascotValue('19') }];
    h.ready = true;
    const v = render(<MascotHost />);
    h.route = 'settings';
    act(() => v.rerender(<MascotHost />));
    h.rows = [{ id: 'k', key: MASCOT_KEY, value: mascotValue('3') }];
    h.route = 'today';
    act(() => v.rerender(<MascotHost />));
    expect(h.ids).toEqual(['19', '3']);
    expect(h.destroyed).toBe(1);
  });

  it('还没画出来就切走的不留：回来重新建', () => {
    h.rows = [{ id: 'k', key: MASCOT_KEY, value: mascotValue('19') }];
    const v = render(<MascotHost />);
    h.route = 'settings';
    act(() => v.rerender(<MascotHost />));
    expect(mascotSession.kept).toBeNull();
    expect(h.destroyed).toBe(1);
    h.route = 'today';
    act(() => v.rerender(<MascotHost />));
    expect(h.ids).toEqual(['19', '19']);
  });
});
