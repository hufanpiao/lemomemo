// B2 FA-4 新加的 platform 能力：键盘弹起（viewport.ts）、关掉已处理的系统通知（notifications.ts）、通知权限（perm.ts）、启动认领结果（push-status.ts）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetNativeBridgeForTest, setNativeBridge, showLocalTestNotification, webBridge, type NativeBridge } from '../native-bridge.ts';
import { closeHandledNotifications, parseReminderTag } from '../notifications.ts';
import { notificationPermission, requestNotificationPermission } from '../perm.ts';
import { getPushOutcome, setPushOutcome, subscribePushOutcome } from '../push-status.ts';
import { blockPageZoom, createKeyboardWatcher } from '../viewport.ts';
import { keyboardHeight, KB_MIN_PX } from '../viewport-geom.ts';

const ID = '0b6f4f1e-2c7d-4a7e-9a55-111111111111';

describe('键盘弹起（架构 5.9）', () => {
  it('键盘高度 = 布局视口 − 可视视口 − 顶端偏移；地址栏伸缩（不到 120px）不算', () => {
    expect(keyboardHeight(800, 500, 0)).toBe(300);
    expect(keyboardHeight(800, 450, 50)).toBe(300);
    expect(keyboardHeight(800, 800 - KB_MIN_PX + 1, 0)).toBe(0);
    expect(keyboardHeight(800, 800 - KB_MIN_PX, 0)).toBe(KB_MIN_PX);
  });
  it('弹起 / 收起时通知并写 --kb；最后一个取消后不再监听；没有 visualViewport 什么都不做', () => {
    const handlers = new Map<string, () => void>();
    const vv = {
      height: 800,
      offsetTop: 0,
      addEventListener: vi.fn((k: string, f: () => void) => handlers.set(k, f)),
      removeEventListener: vi.fn((k: string) => handlers.delete(k)),
    };
    const style = { setProperty: vi.fn(), removeProperty: vi.fn() };
    const w = createKeyboardWatcher({ vv: () => vv as never, innerHeight: () => 800, root: () => ({ style }) });
    const fn = vi.fn();
    const off = w.watch(fn);
    expect(fn).not.toHaveBeenCalled();
    vv.height = 480;
    handlers.get('resize')?.();
    expect(fn).toHaveBeenLastCalledWith(true, 320);
    expect(style.setProperty).toHaveBeenCalledWith('--kb', '320px');
    expect(w.isOpen()).toBe(true);
    vv.height = 800;
    handlers.get('resize')?.();
    expect(fn).toHaveBeenLastCalledWith(false, 0);
    expect(style.removeProperty).toHaveBeenCalledWith('--kb');
    off();
    expect(handlers.size).toBe(0);

    const none = createKeyboardWatcher({ vv: () => null });
    const g = vi.fn();
    none.watch(g)();
    expect(g).not.toHaveBeenCalled();
    expect(none.isOpen()).toBe(false);
  });
});

describe('键盘判断的两处补强（代码审查低 6）', () => {
  const mk = () => {
    const handlers = new Map<string, () => void>();
    const docH = new Map<string, () => void>();
    const vv = {
      height: 800,
      offsetTop: 0,
      scale: 1,
      addEventListener: (k: string, f: () => void) => handlers.set(k, f),
      removeEventListener: (k: string) => handlers.delete(k),
    };
    const doc = { addEventListener: (k: string, f: () => void) => docH.set(k, f), removeEventListener: (k: string) => docH.delete(k) };
    const w = createKeyboardWatcher({ vv: () => vv as never, innerHeight: () => 800, root: () => null, doc: () => doc as never });
    return { vv, handlers, docH, w };
  };
  it('双指放大（scale 不是 1）时可视视口变小不算键盘弹起', () => {
    const { vv, handlers, w } = mk();
    const fn = vi.fn();
    w.watch(fn);
    vv.scale = 2;
    vv.height = 400;
    handlers.get('resize')?.();
    expect(fn).not.toHaveBeenCalled();
    expect(w.isOpen()).toBe(false);
    vv.scale = 1;
    handlers.get('resize')?.();
    expect(fn).toHaveBeenLastCalledWith(true, 400);
  });
  it('回到前台（visibilitychange）时重算一次；取消后不再监听', () => {
    const { vv, docH, w } = mk();
    const fn = vi.fn();
    const off = w.watch(fn);
    vv.height = 480;
    docH.get('visibilitychange')?.();
    expect(fn).toHaveBeenLastCalledWith(true, 320);
    off();
    expect(docH.size).toBe(0);
  });
});

describe('关掉已处理的系统通知（架构 5.3 iPhone）', () => {
  it('tag 解析：只认 <kind>:<uuid>:<dueAt>', () => {
    expect(parseReminderTag(`todo:${ID}:1762156800000`)).toEqual({ kind: 'todo', id: ID, dueAt: 1762156800000 });
    for (const t of ['lemo-test', 'lemo-fallback', `note:${ID}:1`, `todo:${ID}:0`, `todo:${ID.toUpperCase()}:1`, `todo:${ID}:1:x`]) expect(parseReminderTag(t), t).toBeNull();
  });
  it('只关判为已处理的提醒通知；测试通知、兜底通知不动', async () => {
    const mk = (tag: string) => ({ tag, close: vi.fn() });
    const a = mk(`todo:${ID}:100`);
    const b = mk(`event:${ID}:200`);
    const c = mk('lemo-test');
    const n = await closeHandledNotifications((t) => t.dueAt === 100, { registration: async () => ({ getNotifications: async () => [a, b, c] }) });
    expect(n).toBe(1);
    expect(a.close).toHaveBeenCalled();
    expect(b.close).not.toHaveBeenCalled();
    expect(c.close).not.toHaveBeenCalled();
  });
  it('不支持 getNotifications、没注册、抛错：返回 unsupported，不抛', async () => {
    expect(await closeHandledNotifications(() => true, { registration: async () => ({}) })).toBe('unsupported');
    expect(await closeHandledNotifications(() => true, { registration: async () => null })).toBe('unsupported');
    expect(await closeHandledNotifications(() => true, { registration: async () => { throw new Error('x'); } })).toBe('unsupported');
  });
});

describe('通知权限', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('没有 Notification：读为 null，请求按 default', async () => {
    vi.stubGlobal('Notification', undefined);
    expect(notificationPermission()).toBeNull();
    expect(await requestNotificationPermission()).toBe('default');
  });
  it('有：读 permission，请求走 requestPermission；抛错按 default', async () => {
    const N = { permission: 'denied', requestPermission: vi.fn(async () => 'granted') };
    vi.stubGlobal('Notification', N);
    expect(notificationPermission()).toBe('denied');
    expect(await requestNotificationPermission()).toBe('granted');
    N.requestPermission.mockRejectedValueOnce(new Error('x'));
    expect(await requestNotificationPermission()).toBe('default');
  });
});

describe('启动认领结果', () => {
  it('写进去能读、通知订阅者', () => {
    const fn = vi.fn();
    const off = subscribePushOutcome(fn);
    setPushOutcome({ result: 'claimed' });
    expect(getPushOutcome()).toEqual({ result: 'claimed' });
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    setPushOutcome(null);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('exe 本机测试通知（R-330，待接口 showLocalTest）', () => {
  afterEach(() => resetNativeBridgeForTest());
  const n = { title: '柠檬记测试通知', body: 'x' };
  const withTest = (fn: NonNullable<NativeBridge['showLocalTest']>): void => setNativeBridge({ ...webBridge(), showLocalTest: fn });
  it('网页版、exe 还没实现 showLocalTest：回 failed', async () => {
    expect(await showLocalTestNotification(n)).toBe('failed');
    setNativeBridge(webBridge());
    expect(await showLocalTestNotification(n)).toBe('failed');
  });
  it('实现了：已弹出 / 权限没开照原样回，文案原样传进去；抛错、认不出的回 failed', async () => {
    const fn = vi.fn(async () => 'shown' as const);
    withTest(fn);
    expect(await showLocalTestNotification(n)).toBe('shown');
    expect(fn).toHaveBeenCalledWith(n);
    withTest(async () => 'denied');
    expect(await showLocalTestNotification(n)).toBe('denied');
    withTest(async () => {
      throw new Error('x');
    });
    expect(await showLocalTestNotification(n)).toBe('failed');
    withTest(async () => 'weird' as never);
    expect(await showLocalTestNotification(n)).toBe('failed');
  });
});

describe('禁止整页双指缩放（负责人 11-11，blockPageZoom）', () => {
  const fire = (type: string): Event => {
    const e = new Event(type, { cancelable: true });
    document.dispatchEvent(e);
    return e;
  };

  it('iOS 的 gesturestart、gesturechange、gestureend 都被 preventDefault，以非被动方式登记；取消后不再拦', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const stop = blockPageZoom();
    for (const g of ['gesturestart', 'gesturechange', 'gestureend']) {
      expect(add).toHaveBeenCalledWith(g, expect.any(Function), { passive: false });
      expect(fire(g).defaultPrevented, g).toBe(true);
    }
    stop();
    for (const g of ['gesturestart', 'gesturechange', 'gestureend']) expect(fire(g).defaultPrevented, g).toBe(false);
    add.mockRestore();
  });

  it('只拦 gesture 事件：触摸、滚动、双击不碰（横滑翻页、竖向滚动、拖动柄照常）', () => {
    const stop = blockPageZoom();
    for (const t of ['touchstart', 'touchmove', 'touchend', 'wheel', 'dblclick', 'pointermove']) expect(fire(t).defaultPrevented, t).toBe(false);
    stop();
  });

  it('没有 document 时什么都不做、不抛', () => {
    expect(() => blockPageZoom(null)()).not.toThrow();
  });
});
