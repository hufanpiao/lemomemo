// SW 通知上的按钮（src/sw/push.ts、src/sw/push-actions.ts；R-294、R-307、R-308）：
// 待办“推迟 + 完成”、日程和纪念日“推迟 + 知道了”；负载里有的才显示；点“完成”和推迟走同一条 pending 路径，点“知道了”只关通知
import { describe, expect, it, vi } from 'vitest';
import { NOTIFY_ACTIONS, SNOOZE_MIN } from '../../shared/logic/notify-text.ts';
import { buildPayload, type PayloadInput } from '../../supabase/functions/_shared/push/payload.ts';
import { claimCache } from '../../src/core/account.ts';
import { openCache } from '../../src/core/cache.ts';
import { PENDING_ACTIONS } from '../../src/core/cache-schema.ts';
import { isValidPendingAction } from '../../src/core/pending-actions.ts';
import { fakeIndexedDB } from '../../src/core/__tests__/idb-fake.ts';
import type { SwPendingAction } from '../../src/sw/pending.ts';
import { clipText, dataOf, handleNotificationClick, notificationOf, parsePushPayload, reminderUrl, type SwLike } from '../../src/sw/push.ts';

const UID = '11111111-1111-4111-8111-111111111111';
const ID = '33333333-3333-4333-8333-333333333333';
const DUE = 1_800_000_000_000;
const ZH = ['zh-CN'];

const remind = (kind: 'event' | 'todo' | 'anniv', over: Record<string, unknown> = {}) => ({
  v: 1, type: 'remind', user_id: UID, kind, id: ID, due_at: DUE, title: '周会', body: '10:00',
  snooze: { label: '推迟', minutes: SNOOZE_MIN }, done: { label: '完成' }, ack: { label: '知道了' }, ...over,
});

const shownActions = (raw: unknown) => {
  const p = parsePushPayload(raw);
  if (!p) throw new Error('解不开');
  return notificationOf(p, ZH).options.actions?.map((a) => a.action) ?? [];
};

async function ownedDb() {
  const { factory } = fakeIndexedDB();
  const c = await openCache({ factory });
  if (!c.ok) throw new Error(c.reason);
  await claimCache(c.cache, UID);
  return { factory, cache: c.cache };
}

function fakeSw(factory: IDBFactory) {
  const opened: string[] = [];
  const sw: SwLike = {
    registration: { showNotification: vi.fn(async () => undefined), getNotifications: vi.fn(async () => []) },
    clients: {
      matchAll: vi.fn(async () => []),
      openWindow: vi.fn(async (u: string | URL) => {
        opened.push(String(u));
        return null;
      }),
    },
    location: { origin: 'https://lemomemo.com' },
    indexedDB: factory,
    now: () => DUE + 500,
    uuid: () => 'pending-1',
    languages: ZH,
  };
  return { sw, opened };
}

const dataFor = (raw: unknown) => {
  const p = parsePushPayload(raw);
  if (!p) throw new Error('解不开');
  return notificationOf(p, ZH).options.data;
};

describe('三类条目的按钮（R-308）', () => {
  it('待办：推迟 + 完成（不认 ack）；日程、纪念日：推迟 + 知道了（不认 done）；顺序同 actionsFor', () => {
    expect(shownActions(remind('todo'))).toEqual(['snooze', 'done']);
    expect(shownActions(remind('event'))).toEqual(['snooze', 'ack']);
    expect(shownActions(remind('anniv'))).toEqual(['snooze', 'ack']);
    expect(NOTIFY_ACTIONS.snooze.action).toBe('snooze');
  });

  it('负载里没有的按钮不显示；label 空、格式不对当没有；文字超 40 码点截断', () => {
    expect(shownActions(remind('todo', { done: null }))).toEqual(['snooze']);
    expect(shownActions(remind('todo', { snooze: undefined, done: { label: '' } }))).toEqual([]);
    expect(shownActions(remind('event', { snooze: { label: '推迟', minutes: 0 } }))).toEqual(['ack']);
    const p = parsePushPayload(remind('event', { ack: { label: '知'.repeat(50) } }));
    expect(p?.type === 'remind' ? Array.from(p.ack?.label ?? '').length : 0).toBe(40);
  });

  it('和后端 buildPayload 对拍：按类型带的按钮，SW 照样显示', () => {
    const td = new TextDecoder();
    const base = { user_id: UID, id: ID, due_at: DUE, title: '周会', body: '10:00', snooze: { label: '推迟', minutes: SNOOZE_MIN }, done: { label: '完成' }, ack: { label: '知道了' } };
    for (const [kind, want] of [['todo', ['snooze', 'done']], ['event', ['snooze', 'ack']]] as const) {
      const raw: unknown = JSON.parse(td.decode(buildPayload({ type: 'remind', kind, ...base } as PayloadInput)));
      expect(shownActions(raw)).toEqual(want);
    }
  });

  it('通知 data：待办有“完成”时 done_ok；dataOf 不认日程上的 done_ok', () => {
    expect(dataFor(remind('todo'))).toMatchObject({ done_ok: true });
    expect(dataFor(remind('todo', { done: null }))).toMatchObject({ done_ok: false });
    expect(dataOf({ data: { user_id: UID, kind: 'event', id: ID, due_at: DUE, snooze_minutes: 10, done_ok: true } })?.done_ok).toBe(false);
  });
});

describe('点按钮的处理', () => {
  it('点“完成”（待办）：和推迟同一条 pending 路径写一条 {type: done, due_at}，再打开整页提醒（在那里能撤销）；页面一侧校验认它', async () => {
    const db = await ownedDb();
    const { sw, opened } = fakeSw(db.factory);
    const close = vi.fn();
    const r = await handleNotificationClick(sw, { data: dataFor(remind('todo')), close }, 'done');
    expect(close).toHaveBeenCalled();
    expect(r).toEqual({ opened: reminderUrl('todo', ID, DUE), snooze: null, done: 'ok' });
    expect(opened).toHaveLength(1);
    const rows = await db.cache.tx([PENDING_ACTIONS], 'readonly', (tx) => tx.getAll<SwPendingAction>(PENDING_ACTIONS));
    expect(rows).toEqual([{ id: 'pending-1', user_id: UID, row_table: 'todos', row_id: ID, action: { type: 'done', due_at: DUE }, created_at: DUE + 500 }]);
    expect(rows.every((a) => isValidPendingAction(a))).toBe(true);
    db.cache.close();
  });

  it('点“知道了”（日程、纪念日）：只关通知，不写库、不开窗口', async () => {
    const db = await ownedDb();
    for (const kind of ['event', 'anniv'] as const) {
      const { sw, opened } = fakeSw(db.factory);
      const close = vi.fn();
      const r = await handleNotificationClick(sw, { data: dataFor(remind(kind)), close }, 'ack');
      expect(close).toHaveBeenCalled();
      expect(r).toEqual({ opened: null, snooze: null, done: null });
      expect(opened).toEqual([]);
    }
    const rows = await db.cache.tx([PENDING_ACTIONS], 'readonly', (tx) => tx.getAll(PENDING_ACTIONS));
    expect(rows).toEqual([]);
    db.cache.close();
  });

  it('点“推迟”：写 {type: snooze, minutes: 10}；通知上没有“完成”时点 done 不写（只打开整页提醒）', async () => {
    const db = await ownedDb();
    const a = fakeSw(db.factory);
    expect(await handleNotificationClick(a.sw, { data: dataFor(remind('event')), close: vi.fn() }, 'snooze')).toMatchObject({ snooze: 'ok', done: null });
    const b = fakeSw(db.factory);
    expect(await handleNotificationClick(b.sw, { data: dataFor(remind('todo', { done: null })), close: vi.fn() }, 'done')).toMatchObject({ snooze: null, done: null });
    expect(b.opened).toHaveLength(1);
    const rows = await db.cache.tx([PENDING_ACTIONS], 'readonly', (tx) => tx.getAll<SwPendingAction>(PENDING_ACTIONS));
    expect(rows.map((x) => x.action)).toEqual([{ type: 'snooze', minutes: SNOOZE_MIN, due_at: DUE }]);
    db.cache.close();
  });

  it('页面一侧校验：done 只认 todos 表', () => {
    const base = { id: 'p', user_id: UID, row_id: ID, created_at: DUE };
    expect(isValidPendingAction({ ...base, row_table: 'todos', action: { type: 'done', due_at: DUE } })).toBe(true);
    expect(isValidPendingAction({ ...base, row_table: 'events', action: { type: 'done', due_at: DUE } })).toBe(false);
  });
});

describe('控制字符过滤（BE-2 安全审查）', () => {
  const ch = (...codes: number[]) => String.fromCharCode(...codes);
  const BAD = [0x00, 0x09, 0x0a, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c, 0x2028, 0x2029, 0xfeff];

  it('C0、DEL、C1、双向控制符、方向标记、行段分隔符、U+FEFF 一律换成空格；普通字、emoji、零宽连接符不动', () => {
    for (const c of BAD) expect(clipText(`a${ch(c)}b`), c.toString(16)).toBe('a b');
    expect(clipText('周会 😀 회의 é')).toBe('周会 😀 회의 é');
    // 零宽连接符 U+200D 不在名单里（emoji 组合要用它；和后端同一套）
    expect(clipText(`x${ch(0x200d)}y`)).toBe(`x${ch(0x200d)}y`);
  });

  it('标题、正文、按键文字都过滤（先过滤再截断）', () => {
    const p = parsePushPayload(remind('todo', {
      title: `周${ch(0x202e)}会`,
      body: `10:00${ch(0x7f)}`,
      snooze: { label: `推${ch(0x85)}迟`, minutes: SNOOZE_MIN },
      done: { label: `完${ch(0x2066)}成` },
    }));
    if (p?.type !== 'remind') throw new Error('解不开');
    expect([p.title, p.body, p.snooze?.label, p.done?.label]).toEqual(['周 会', '10:00 ', '推 迟', '完 成']);
  });
});

