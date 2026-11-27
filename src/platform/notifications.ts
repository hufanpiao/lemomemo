// 打开 App 时用 getNotifications() 关掉已经处理过的系统通知（不发 resolve 推送）
// • 只认 tag 形如 "<kind>:<id>:<dueAt>" 的（remind-route 的 reminderTag）；lemo-test、lemo-fallback 不动
// • data 里的 occurrence_key 经 validOccurrenceKey 校验，不合格当没带
// • 不支持 getNotifications / close 时返回 'unsupported'：只靠整页提醒里的“已在其他设备上处理”
// • exe 不走这里（由 closeLocalReminder 撤回）
import { validOccurrenceKey, type ReminderKind } from '../../shared/logic/remind-route.ts';

export interface ShownReminderTag {
  readonly kind: ReminderKind;
  readonly id: string;
  readonly dueAt: number;
  /** 通知 data 里带的 occurrenceKey（校验过）；只比较、不显示 */
  readonly occurrenceKey?: string | null;
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

type NotificationLike = Pick<Notification, 'tag' | 'close'> & { readonly data?: unknown };
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
      const tag = parseReminderTag(x.tag);
      const raw = typeof x.data === 'object' && x.data !== null ? (x.data as { occurrence_key?: unknown }).occurrence_key : undefined;
      const t = tag && { ...tag, occurrenceKey: validOccurrenceKey(raw, tag.kind, tag.id, tag.dueAt) };
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
