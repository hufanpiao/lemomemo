// disconnectBrowserPush 按通知权限跳过退订（src/platform/push.ts；接手清单 PUSH-getsub-hang，B2 FA-3 安全审查第三节 P-1～P-6）
// 通知权限明确是 denied / default：不调 getSubscription，关通知、删认领记录照常；granted、拿不准（没有 Notification、读取抛错）照常退订
import { describe, expect, it, vi } from 'vitest';
import { CLAIM_STORAGE_KEY, disconnectBrowserPush, type PushRegistrationLike } from '../push.ts';

function fakeSub() {
  return {
    endpoint: 'https://push.example/ep/1',
    unsubscribe: vi.fn(async () => true),
  };
}

describe('disconnectBrowserPush 按通知权限跳过退订（PUSH-getsub-hang）', () => {
  function setup() {
    const sub = fakeSub();
    const closed: string[] = [];
    const reg = {
      getNotifications: vi.fn(async () => [{ tag: 'event:a:1', close: () => void closed.push('event:a:1') }]),
      pushManager: { getSubscription: vi.fn(async () => sub) },
    };
    const m = new Map<string, string>([[CLAIM_STORAGE_KEY, 'ok\nxxxx']]);
    const storage = { removeItem: (k: string) => void m.delete(k) } as unknown as Storage;
    const base = { win: {}, registration: async () => reg as unknown as PushRegistrationLike, storage: () => storage };
    return { sub, closed, reg, m, base };
  }

  it.each(['denied', 'default'] as const)('%s：不调 getSubscription，但照常关通知、删认领记录（P-1、P-4）', async (perm) => {
    const { sub, closed, reg, m, base } = setup();
    await disconnectBrowserPush({ ...base, permission: () => perm });
    expect(reg.pushManager.getSubscription).not.toHaveBeenCalled();
    expect(sub.unsubscribe).not.toHaveBeenCalled();
    expect(reg.getNotifications).toHaveBeenCalledOnce();
    expect(closed).toEqual(['event:a:1']);
    expect(m.has(CLAIM_STORAGE_KEY)).toBe(false);
  });

  it('granted：照常退订', async () => {
    const { sub, reg, m, base } = setup();
    await disconnectBrowserPush({ ...base, permission: () => 'granted' });
    expect(reg.pushManager.getSubscription).toHaveBeenCalledOnce();
    expect(sub.unsubscribe).toHaveBeenCalledOnce();
    expect(m.has(CLAIM_STORAGE_KEY)).toBe(false);
  });

  it('拿不准就照常退订：没有 Notification（null）、读取抛错、意外的值（P-2）', async () => {
    const readers: Array<() => NotificationPermission | null> = [
      () => null,
      () => { throw new Error('blocked'); },
      () => 'prompt' as unknown as NotificationPermission,
    ];
    for (const permission of readers) {
      const { sub, reg, base } = setup();
      await disconnectBrowserPush({ ...base, permission });
      expect(reg.pushManager.getSubscription).toHaveBeenCalledOnce();
      expect(sub.unsubscribe).toHaveBeenCalledOnce();
    }
  });

  it('默认读 Notification.permission：没有 Notification 照常退订（不当 default），denied 跳过，读取抛错照常退订（P-2、P-3）', async () => {
    try {
      vi.stubGlobal('Notification', undefined);
      let s = setup();
      await disconnectBrowserPush(s.base);
      expect(s.sub.unsubscribe).toHaveBeenCalledOnce();

      vi.stubGlobal('Notification', { permission: 'denied' });
      s = setup();
      await disconnectBrowserPush(s.base);
      expect(s.reg.pushManager.getSubscription).not.toHaveBeenCalled();
      expect(s.closed).toEqual(['event:a:1']);

      vi.stubGlobal('Notification', { permission: 'granted' });
      s = setup();
      await disconnectBrowserPush(s.base);
      expect(s.sub.unsubscribe).toHaveBeenCalledOnce();

      vi.stubGlobal('Notification', Object.defineProperty({}, 'permission', { get() { throw new Error('SecurityError'); } }));
      s = setup();
      await disconnectBrowserPush(s.base);
      expect(s.sub.unsubscribe).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('exe 分支不看通知权限：照旧只关本机通知（P-1）', async () => {
    const registration = vi.fn(async () => null);
    const closeLocal = vi.fn(async () => undefined);
    const permission = vi.fn(() => 'denied' as const);
    await disconnectBrowserPush({ win: { __TAURI_INTERNALS__: {} }, registration, closeLocal, permission });
    expect(closeLocal).toHaveBeenCalledOnce();
    expect(registration).not.toHaveBeenCalled();
    expect(permission).not.toHaveBeenCalled();
  });
});
