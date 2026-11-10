// src/platform/desktop.ts：exe 版的四个 platform 函数（假的 invoke、go、Notification）
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { desktopBridge, installDesktopBridge, quickAddText, QUICK_ADD_MAX_CHARS, toSwUpdateResult, type DesktopDeps, type NotificationLike } from '../desktop.ts';
import { resetNativeBridgeForTest, type LocalReminder } from '../native-bridge.ts';

class FakeNotification implements NotificationLike {
  static all: FakeNotification[] = [];
  static permission: 'default' | 'granted' | 'denied' = 'granted';
  static asked = 0;
  static answer: 'granted' | 'denied' = 'granted';
  static async requestPermission() {
    FakeNotification.asked++;
    FakeNotification.permission = FakeNotification.answer;
    return FakeNotification.answer;
  }
  onclick: NotificationLike['onclick'] = null;
  onclose: NotificationLike['onclose'] = null;
  closed = false;
  readonly title: string;
  readonly options: { body: string; tag: string; data?: unknown };
  constructor(title: string, options: { body: string; tag: string; data?: unknown }) {
    this.title = title;
    this.options = options;
    FakeNotification.all.push(this);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.call(this, {});
  }
  click(): void {
    this.onclick?.call(this, {});
  }
}

function setup(invokeImpl: (cmd: string) => unknown = () => null) {
  FakeNotification.all = [];
  FakeNotification.permission = 'granted';
  FakeNotification.asked = 0;
  FakeNotification.answer = 'granted';
  const calls: string[] = [];
  const loc = { hash: '' };
  const deps: DesktopDeps = {
    invoke: async (cmd) => {
      calls.push(cmd);
      return invokeImpl(cmd);
    },
    go: (h: string) => void (loc.hash = h),
    Notification: FakeNotification,
  };
  return { bridge: desktopBridge(deps), calls, loc };
}

const R: LocalReminder = { tag: 'event:e1:1700000000000', kind: 'event', id: 'e1', dueAt: 1700000000000, title: '提醒', body: '10:00 开会' };
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => resetNativeBridgeForTest());

describe('requestAppUpdate：Rust 结果折算成 SwUpdateResult', () => {
  it('四种结果和未配置', () => {
    expect(toSwUpdateResult('installing')).toBe('reloading');
    expect(toSwUpdateResult('up_to_date')).toBe('no_update');
    expect(toSwUpdateResult('error')).toBe('failed');
    expect(toSwUpdateResult('timeout')).toBe('takeover_timeout');
    expect(toSwUpdateResult('not_configured')).toBe('failed');
    expect(toSwUpdateResult(undefined)).toBe('failed');
  });

  it('调 app_update；调用抛错算 failed', async () => {
    const ok = setup(() => 'up_to_date');
    expect(await ok.bridge.requestAppUpdate()).toBe('no_update');
    expect(ok.calls).toEqual(['app_update']);
    const bad = setup(() => {
      throw new Error('window_not_allowed');
    });
    expect(await bad.bridge.requestAppUpdate()).toBe('failed');
  });
});

describe('openAuth（S8）', () => {
  it('调 auth_window_open，主窗口不导航', async () => {
    const { bridge, calls, loc } = setup();
    await bridge.openAuth();
    expect(calls).toEqual(['auth_window_open']);
    expect(loc.hash).toBe('');
  });
  it('打开失败时抛给调用方', async () => {
    const { bridge } = setup(() => {
      throw new Error('window_not_allowed');
    });
    await expect(bridge.openAuth()).rejects.toThrow('window_not_allowed');
  });
});

describe('openReminder', () => {
  it('先拉到前台再改 hash（地址和 SW 的 reminderUrl 同一规则）', async () => {
    const { bridge, calls, loc } = setup();
    await bridge.openReminder('todo', 't1', 1700000000000);
    expect(calls).toEqual(['main_show']);
    expect(loc.hash).toBe('#/remind/todo/t1?due=1700000000000');
  });

  it('main_show 失败也照样切页', async () => {
    const { bridge, loc } = setup(() => {
      throw new Error('x');
    });
    await bridge.openReminder('anniv', 'a1', 5);
    expect(loc.hash).toBe('#/remind/anniv/a1?due=5');
  });
});

describe('本机通知', () => {
  it('原样显示 title、body、tag', async () => {
    const { bridge } = setup();
    await bridge.showLocalReminder(R);
    expect(FakeNotification.all.map((n) => [n.title, n.options])).toEqual([['提醒', { body: '10:00 开会', tag: R.tag }]]);
  });

  it('带 occurrenceKey 的放进 data.occurrence_key（撤回时按 key 判，REMIND-close-occkey）', async () => {
    const { bridge } = setup();
    await bridge.showLocalReminder({ ...R, occurrenceKey: 'event:e1:allday:2023-11-15:0' });
    expect(FakeNotification.all[0]?.options).toEqual({ body: '10:00 开会', tag: R.tag, data: { occurrence_key: 'event:e1:allday:2023-11-15:0' } });
  });

  it('点通知：关掉通知、拉到前台、打开整页提醒', async () => {
    const { bridge, calls, loc } = setup();
    await bridge.showLocalReminder(R);
    FakeNotification.all[0]?.click();
    await flush();
    expect(FakeNotification.all[0]?.closed).toBe(true);
    expect(calls).toEqual(['main_show']);
    expect(loc.hash).toBe('#/remind/event/e1?due=1700000000000');
  });

  it('按 tag 撤回；没有这条不报错', async () => {
    const { bridge } = setup();
    await bridge.showLocalReminder(R);
    await bridge.showLocalReminder({ ...R, tag: 'todo:t1:1', kind: 'todo', id: 't1', dueAt: 1 });
    await bridge.closeLocalReminder(R.tag);
    expect(FakeNotification.all.map((n) => n.closed)).toEqual([true, false]);
    await expect(bridge.closeLocalReminder('nope')).resolves.toBeUndefined();
  });

  it('X-5：closeAllLocalReminders 关掉已弹出的全部通知，之后按 tag 撤回不再碰到它们', async () => {
    const { bridge } = setup();
    await bridge.showLocalReminder(R);
    await bridge.showLocalReminder({ ...R, tag: 'todo:t1:1', kind: 'todo', id: 't1', dueAt: 1 });
    await bridge.showLocalReminder({ ...R, tag: 'todo:t2:2', kind: 'todo', id: 't2', dueAt: 2 });
    await bridge.closeLocalReminder('todo:t1:1'); // 先撤回一条
    await bridge.closeAllLocalReminders();
    expect(FakeNotification.all.map((n) => n.closed)).toEqual([true, true, true]);
    // 再调一次、没有通知时调都不报错
    await expect(bridge.closeAllLocalReminders()).resolves.toBeUndefined();
    // 关完以后照常能弹新的（下一个账号登录后）
    await bridge.showLocalReminder(R);
    expect(FakeNotification.all.at(-1)?.closed).toBe(false);
  });

  it('X-5：某一条 close 抛错不影响别的', async () => {
    const { bridge } = setup();
    await bridge.showLocalReminder(R);
    await bridge.showLocalReminder({ ...R, tag: 'todo:t1:1', kind: 'todo', id: 't1', dueAt: 1 });
    const first = FakeNotification.all[0];
    if (!first) throw new Error('应先弹出一条');
    first.close = () => {
      throw new Error('boom');
    };
    await expect(bridge.closeAllLocalReminders()).resolves.toBeUndefined();
    expect(FakeNotification.all[1]?.closed).toBe(true);
  });

  it('X-5：还在等权限的那次弹出，赶上 closeAllLocalReminders 就不弹了（退出后不冒出上一个账号的通知）', async () => {
    const { bridge } = setup();
    FakeNotification.permission = 'default';
    let release!: (v: 'granted') => void;
    const orig = FakeNotification.requestPermission;
    onTestFinished(() => {
      FakeNotification.requestPermission = orig;
    });
    FakeNotification.requestPermission = () =>
      new Promise((r) => {
        release = (v) => {
          FakeNotification.permission = v;
          r(v);
        };
      });
    const pending = bridge.showLocalReminder(R);
    await flush();
    await bridge.closeAllLocalReminders();
    release('granted');
    await pending;
    expect(FakeNotification.all).toHaveLength(0);
  });

  it('同一个 tag 再弹一次替换旧的，撤回时关的是新的', async () => {
    const { bridge } = setup();
    await bridge.showLocalReminder(R);
    await bridge.showLocalReminder({ ...R, body: '改过' });
    expect(FakeNotification.all.map((n) => n.closed)).toEqual([true, false]);
    await bridge.closeLocalReminder(R.tag);
    expect(FakeNotification.all.map((n) => n.closed)).toEqual([true, true]);
  });

  it('还没问过权限时先请求一次，放行后再弹', async () => {
    const { bridge } = setup();
    FakeNotification.permission = 'default';
    await bridge.showLocalReminder(R);
    expect(FakeNotification.asked).toBe(1);
    expect(FakeNotification.all).toHaveLength(1);
  });

  it('权限被拒（请求后拒绝、或本来就拒绝）时不弹', async () => {
    const { bridge } = setup();
    FakeNotification.permission = 'default';
    FakeNotification.answer = 'denied';
    await bridge.showLocalReminder(R);
    await bridge.showLocalReminder(R);
    expect(FakeNotification.asked).toBe(1);
    expect(FakeNotification.all).toHaveLength(0);
  });

  it('没有 Notification 时静默跳过', async () => {
    const bridge = desktopBridge({ invoke: async () => null, go: () => undefined, Notification: undefined });
    await expect(bridge.showLocalReminder(R)).resolves.toBeUndefined();
  });
});

describe('installDesktopBridge', () => {
  it('不在 Tauri 里时不装、返回 false', () => {
    expect(installDesktopBridge()).toBe(false);
  });
});

describe('quick-add 交上来的文字（X-S6）', () => {
  it('只认 { text: string }，原样交出纯文本', () => {
    expect(quickAddText({ text: '<b>明天</b> 10 点开会' })).toBe('<b>明天</b> 10 点开会');
    expect(quickAddText({ text: '' })).toBe('');
  });
  it('类型不对、超长的丢掉', () => {
    expect(quickAddText(null)).toBeNull();
    expect(quickAddText('x')).toBeNull();
    expect(quickAddText({ text: 1 })).toBeNull();
    expect(quickAddText({ text: '柠'.repeat(QUICK_ADD_MAX_CHARS) })).toBe('柠'.repeat(QUICK_ADD_MAX_CHARS));
    expect(quickAddText({ text: '柠'.repeat(QUICK_ADD_MAX_CHARS + 1) })).toBeNull();
  });
});

