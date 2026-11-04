// 打开 App 时关掉已经处理过的系统通知（架构 5.3“iPhone”：不发 resolve，下次打开 App 时用 getNotifications() 关掉已处理的；B2 任务单 FA-4）
// • 只认 tag 形如 "<kind>:<id>:<dueAt>" 的（remind-route 的 reminderTag）；lemo-test、lemo-fallback 不动
// • 不支持 getNotifications / close（iOS 主屏幕版未核实，真机 ⑤ 实测）时什么都不做、返回 'unsupported'：只靠整页提醒里的“已在其他设备上处理”
// • exe 不走这里（exe 的本机通知由 closeLocalReminder 撤回）
import type { ReminderKind } from '../../shared/logic/remind-route.ts';

export interface ShownReminderTag {
  readonly kind: ReminderKind;
  readonly id: string;
  readonly dueAt: number;
}

const TAG_RE = /^(event|todo|anniv):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-9][0-9]*)$/;

/** 通知 tag → 哪一条哪一次；认不出的返回 null */
export function parseReminderTag(tag: string): ShownReminderTag | null {
  const m = TAG_RE.exec(tag);
  if (!m) return null;
  const dueAt = Number(m[3]);
  if (!Number.isSafeInteger(dueAt)) return null;
  return { kind: m[1] as ReminderKind, id: m[2] as string, dueAt };
}

type NotificationLike = Pick<Notification, 'tag' | 'close'>;
type RegLike = { getNotifications?: (filter?: GetNotificationOptions) => Promise<readonly NotificationLike[]> };

export interface CloseEnv {
  readonly registration?: () => Promise<RegLike | null | undefined>;
}

const defaultRegistration = async (): Promise<RegLike | null> => {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration('/app/')) ?? null;
};

/**
 * 关掉 shouldClose 判为“已处理”的提醒通知；返回关了几条，不支持时 'unsupported'。不抛错
 */
export async function closeHandledNotifications(shouldClose: (t: ShownReminderTag) => boolean, env: CloseEnv = {}): Promise<number | 'unsupported'> {
  try {
    const reg = await (env.registration ?? defaultRegistration)();
    if (!reg || typeof reg.getNotifications !== 'function') return 'unsupported';
    const list = await reg.getNotifications();
    let n = 0;
    for (const x of list) {
      const t = parseReminderTag(x.tag);
      if (t && shouldClose(t) && typeof x.close === 'function') {
        x.close();
        n++;
      }
    }
    return n;
  } catch {
    return 'unsupported';
  }
}
