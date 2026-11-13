// SW 的推送和通知（src/sw/push.ts；架构 5.3；B2 任务单 FA-1，第一天派工表第 9 行）
// 负载 v1 按任务单“接口先定”第 2 条（代码审查 M1）：账号字段叫 user_id；resolve、test 不带标题，SW 用本地词典的固定文案。
// 这里守住 SW 一侧的行为：
//   解析（格式不对一律 null；标题、正文超长截断不拒收）、tag、resolve 先关旧通知再替换（不出兜底）、
//   显示前核对 owner（B2 安全审查 FE-1：没有库、没有 owner、不一致只显示 App 名，不建库）、解不开时按浏览器语言显示 App 名、
//   点通知打开整页提醒（有窗口就聚焦跳转；data 校验不过只打开 /app/，FE-3）、点“推迟”按 K-sw-seal 写 pending_actions
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../shared/i18n/i18n.ts';
import { buildPayload, VAULT_PUSH_EVENTS as SERVER_VAULT_EVENTS, type PayloadInput } from '../../supabase/functions/_shared/push/payload.ts';
import { VAULT_PUSH_EVENTS, VAULT_PUSH_TEXT } from '../../src/sw/push-vault-data.ts';
import { claimCache } from '../../src/core/account.ts';
import { openCache } from '../../src/core/cache.ts';
import { PENDING_ACTIONS } from '../../src/core/cache-schema.ts';
import { fakeIndexedDB } from '../../src/core/__tests__/idb-fake.ts';
import type { SwPendingAction } from '../../src/sw/pending.ts';
import {
  clipText,
  dataOf,
  FALLBACK_TAG,
  fallbackTitle,
  handleNotificationClick,
  handlePush,
  notificationOf,
  notificationTag,
  parsePushPayload,
  reminderUrl,
  TEST_TAG,
  TEXT_MAX,
  VAULT_TAG,
  type PushPayload,
  type SwLike,
  type WindowLike,
} from '../../src/sw/push.ts';

const UID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const DUE = 1_800_000_000_000;
const ORIGIN = 'https://lemomemo.com';
const TAG = `event:${ID}:${DUE}`;
const ZH = ['zh-CN'];

const payload = (over: Record<string, unknown> = {}) => ({
  v: 1,
  type: 'remind',
  user_id: UID,
  kind: 'event',
  id: ID,
  due_at: DUE,
  title: '周会',
  body: '10:00 会议室 A',
  snooze: { label: '10 分钟后', minutes: 10 },
  ...over,
});
/** 按“接口先定”第 2 条：resolve 只有这几样，不带标题 */
const resolvePayload = (over: Record<string, unknown> = {}) => ({ v: 1, type: 'resolve', user_id: UID, kind: 'event', id: ID, due_at: DUE, ...over });

interface Shown {
  title: string;
  options: NotificationOptions & { actions?: { action: string; title: string }[] };
}

/** 本机库归 owner（null = 建了库但还没认领；undefined = 没有库） */
async function factoryOwnedBy(owner: string | null | undefined) {
  const { factory, fake } = fakeIndexedDB();
  if (owner === undefined) return { factory, fake, close: () => undefined };
  const c = await openCache({ factory });
  if (!c.ok) throw new Error(c.reason);
  if (owner) await claimCache(c.cache, owner);
  return { factory, fake, cache: c.cache, close: () => c.cache.close() };
}

function fakeSw(opts: { factory?: IDBFactory; windows?: { url: string; focus?: () => Promise<unknown> }[]; languages?: string[] } = {}) {
  const shown: Shown[] = [];
  const closed: string[] = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  const live: { tag: string; close(): void }[] = [];
  const wins = (opts.windows ?? []).map((w) => {
    const win: WindowLike = {
      url: w.url,
      navigate: async (u: string) => {
        navigated.push(u);
        return win;
      },
      focus: w.focus ? () => (w.focus as () => Promise<unknown>)().then(() => win) : async () => win,
    };
    return win;
  });
  const sw: SwLike = {
    registration: {
      showNotification: vi.fn(async (title: string, options?: NotificationOptions) => {
        shown.push({ title, options: options ?? {} });
        const tag = options?.tag ?? '';
        live.push({ tag, close: () => closed.push(tag) });
      }),
      getNotifications: vi.fn(async (f?: { tag?: string }) => live.filter((n) => !f?.tag || n.tag === f.tag) as unknown as Notification[]),
    },
    clients: {
      matchAll: vi.fn(async () => wins),
      openWindow: vi.fn(async (u: string | URL) => {
        opened.push(String(u));
        return null;
      }),
    },
    location: { origin: ORIGIN },
    indexedDB: opts.factory ?? fakeIndexedDB().factory,
    now: () => DUE + 500,
    uuid: () => 'pending-1',
    languages: opts.languages ?? ZH,
  };
  return { sw, shown, closed, opened, navigated, wins };
}

const parsed = (raw: unknown): PushPayload => {
  const p = parsePushPayload(raw);
  if (!p) throw new Error('解不开');
  return p;
};
const dataFrom = (raw: unknown) => notificationOf(parsed(raw), ZH).options.data;

describe('parsePushPayload（接口先定第 2 条）', () => {
  it('remind：原样解出；body、snooze 可省', () => {
    expect(parsePushPayload(payload())).toMatchObject({ type: 'remind', user_id: UID, kind: 'event', id: ID, due_at: DUE, snooze: { minutes: 10 } });
    expect(parsePushPayload(payload({ body: undefined, snooze: undefined }))).toMatchObject({ body: '', snooze: null });
  });

  it('resolve 不带标题也能解（代码审查 M1）；带了也不用', () => {
    expect(parsePushPayload(resolvePayload())).toEqual({ v: 1, type: 'resolve', user_id: UID, kind: 'event', id: ID, due_at: DUE });
    expect(parsePushPayload(resolvePayload({ title: '周会' }))).not.toHaveProperty('title');
  });

  it('test 只要 v、type、user_id', () => {
    expect(parsePushPayload({ v: 1, type: 'test', user_id: UID })).toEqual({ v: 1, type: 'test', user_id: UID });
    expect(parsePushPayload({ v: 1, type: 'test' })).toBeNull();
  });

  it('标题、正文超长：截断（末尾 …），不整条拒收（代码审查 S1）；不切开 emoji', () => {
    const p = parsed(payload({ title: 'x'.repeat(TEXT_MAX + 50), body: '😀'.repeat(TEXT_MAX + 1) }));
    if (p.type !== 'remind') throw new Error('type');
    expect(Array.from(p.title ?? '')).toHaveLength(TEXT_MAX);
    expect(p.title?.endsWith('…')).toBe(true);
    expect(Array.from(p.body)).toHaveLength(TEXT_MAX);
    expect(Array.from(p.body).slice(0, -1).every((c) => c === '😀')).toBe(true);
    expect(clipText('短')).toBe('短');
  });

  it.each([
    ['不是对象', 'x'],
    ['版本不对', payload({ v: 2 })],
    ['type 不认识', payload({ type: 'spam' })],
    ['还用旧字段名 uid', { ...payload({ user_id: undefined }), uid: UID }],
    ['user_id 不是 UUID', payload({ user_id: 'abc' })],
    ['id 不是 UUID', payload({ id: 'a/b?x=1#y' })],
    ['kind 不认识', payload({ kind: 'note' })],
    ['due_at 不是正整数', payload({ due_at: -1 })],
    ['due_at 是字符串', payload({ due_at: '1' })],
    ['due_at 不是安全整数', payload({ due_at: 2 ** 60 })],
    ['remind 的标题不是字符串', payload({ title: 3 })],
    ['正文不是字符串', payload({ body: 3 })],
    ['resolve 的 id 不合格', resolvePayload({ id: 'x' })],
  ])('%s → null', (_name, raw) => {
    expect(parsePushPayload(raw)).toBeNull();
  });

  it('remind 不带标题（push_show_title 关着，代码审查 M3）：照收，标题为 null', () => {
    for (const title of [undefined, null, '']) {
      expect(parsePushPayload(payload({ title }))).toMatchObject({ type: 'remind', title: null, body: '10:00 会议室 A', snooze: { minutes: 10 } });
    }
  });

  it('snooze 分钟数越界或不是整数：不显示按键（整条照收）', () => {
    for (const minutes of [0, 1441, 1.5, '10']) expect(parsed(payload({ snooze: { label: 'x', minutes } }))).toMatchObject({ snooze: null });
  });
});

describe('tag、地址、通知内容', () => {
  it('tag = "<kind>:<id>:<due_at>"（5.3 第 4 步）', () => {
    expect(notificationTag('todo', ID, DUE)).toBe(`todo:${ID}:${DUE}`);
  });

  it('reminderUrl 的格式钉死（B2 安全审查 FE-3）', () => {
    const re = /^\/app\/#\/remind\/(event|todo|anniv)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\?due=[1-9][0-9]*$/;
    for (const kind of ['event', 'todo', 'anniv'] as const) {
      for (const due of [1, DUE, Number.MAX_SAFE_INTEGER]) expect(reminderUrl(kind, ID, due)).toMatch(re);
    }
    // 经 dataOf 校验过的 data 才会拿来拼地址：拼出来的一定满足上面的格式
    const d = dataOf({ data: dataFrom(payload({ kind: 'anniv' })) });
    expect(d && reminderUrl(d.kind, d.id, d.due_at)).toMatch(re);
  });

  it('remind 带推迟按键；data 里只有账号、id 和时间', () => {
    const r = notificationOf(parsed(payload()), ZH);
    expect(r.title).toBe('周会');
    expect(r.options.actions).toEqual([{ action: 'snooze', title: '10 分钟后' }]);
    expect(r.options.data).toEqual({ user_id: UID, kind: 'event', id: ID, due_at: DUE, snooze_minutes: 10, done_ok: false });
  });

  it('remind 没标题：用 App 名当标题，正文照用负载的，推迟按键、tag、data 都在（代码审查 M3）', () => {
    const r = notificationOf(parsed(payload({ title: undefined })), ZH);
    expect(r.title).toBe(t('app.name', {}, 'zh-CN'));
    expect(r.options).toMatchObject({ body: '10:00 会议室 A', tag: TAG, data: { id: ID, snooze_minutes: 10 } });
    expect(r.options.actions).toEqual([{ action: 'snooze', title: '10 分钟后' }]);
    expect(notificationOf(parsed(payload({ title: undefined })), ['ko-KR']).title).toBe(t('app.name', {}, 'ko-KR'));
  });

  it('resolve、test 的字取本地词典（FE-S1）：中韩两份，负载里的字不用', () => {
    const s = notificationOf(parsed(resolvePayload({ title: '不该出现' })), ZH);
    expect(s.title).toBe(t('app.name', {}, 'zh-CN'));
    expect(s.options.body).toBe(t('push.resolved', {}, 'zh-CN'));
    expect(s.options).toMatchObject({ tag: TAG, silent: true });
    expect(s.options.actions).toBeUndefined();
    const ko = notificationOf(parsed(resolvePayload()), ['ko-KR']);
    expect(ko.options.body).toBe(t('push.resolved', {}, 'ko-KR'));
    expect(ko.options.body).not.toBe(s.options.body);
    const tst = notificationOf(parsed({ v: 1, type: 'test', user_id: UID }), ZH);
    expect(tst.options).toMatchObject({ tag: TEST_TAG, body: t('push.test', {}, 'zh-CN') });
    expect(tst.options.data).toBeUndefined();
  });

  it('dataOf 和负载同一套校验（FE-3）：有一项不合格就 null；分钟数越界当没有', () => {
    const good = { user_id: UID, kind: 'todo', id: ID, due_at: DUE, snooze_minutes: 10, done_ok: false };
    expect(dataOf({ data: good })).toEqual(good);
    expect(dataOf({})).toBeNull();
    for (const bad of [
      { id: 'a/../b' },
      { id: `${ID}?next=https://evil.example` },
      { user_id: 'x' },
      { kind: 'note' },
      { due_at: 0 },
      { due_at: 1.5 },
      { due_at: 2 ** 60 },
      { due_at: '1' },
    ]) {
      expect(dataOf({ data: { ...good, ...bad } }), JSON.stringify(bad)).toBeNull();
    }
    expect(dataOf({ data: { ...good, snooze_minutes: 9999 } })?.snooze_minutes).toBeNull();
  });
});

describe('handlePush：显示前核对账号（FE-1）', () => {
  it('owner 一致：显示负载里的标题、正文和推迟按键，tag 正确', async () => {
    const db = await factoryOwnedBy(UID);
    const { sw, shown } = fakeSw({ factory: db.factory });
    await handlePush(sw, payload());
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ title: '周会', options: { tag: TAG, body: '10:00 会议室 A' } });
    expect(shown[0]?.options.actions).toHaveLength(1);
    db.close();
  });

  it.each([
    ['owner 不一致', OTHER],
    ['建了库还没认领（没有 owner）', null],
    ['本机没有库（已退出）', undefined],
  ] as const)('%s：只显示 App 名，不带正文、按键和 data，tag 照旧', async (_n, owner) => {
    const db = await factoryOwnedBy(owner);
    const { sw, shown } = fakeSw({ factory: db.factory });
    await handlePush(sw, payload());
    expect(shown).toEqual([{ title: fallbackTitle(ZH), options: { tag: TAG } }]);
    if (owner === undefined) {
      // 不留下新库
      const d = db.fake.dbs.get('planner-v4');
      expect(d === undefined || (d.version === 0 && d.stores.size === 0)).toBe(true);
    }
    db.close();
  });

  it('读库出错：按不一致处理', async () => {
    const { sw, shown } = fakeSw({
      factory: {
        open: () => {
          throw new Error('boom');
        },
      } as unknown as IDBFactory,
    });
    await handlePush(sw, payload());
    expect(shown).toEqual([{ title: fallbackTitle(ZH), options: { tag: TAG } }]);
  });

  it('resolve 不带标题：关掉同 tag 的旧通知、显示同 tag 的替换，不出兜底（代码审查 M1）', async () => {
    const db = await factoryOwnedBy(UID);
    const { sw, shown, closed } = fakeSw({ factory: db.factory });
    await handlePush(sw, payload());
    await handlePush(sw, resolvePayload());
    expect(closed).toEqual([TAG]);
    expect(shown.map((s) => s.options.tag)).toEqual([TAG, TAG]);
    expect(shown[1]).toMatchObject({ title: t('app.name', {}, 'zh-CN'), options: { body: t('push.resolved', {}, 'zh-CN'), silent: true } });
    expect(shown.some((s) => s.options.tag === FALLBACK_TAG)).toBe(false);
    db.close();
  });

  it('resolve、owner 不一致：照样关旧通知，替换成只有 App 名的静默通知', async () => {
    const db = await factoryOwnedBy(OTHER);
    const { sw, shown, closed } = fakeSw({ factory: db.factory });
    await handlePush(sw, payload());
    await handlePush(sw, resolvePayload());
    expect(closed).toEqual([TAG]);
    expect(shown[1]).toEqual({ title: fallbackTitle(ZH), options: { tag: TAG, silent: true } });
    db.close();
  });

  it('resolve：getNotifications 不支持也照样显示', async () => {
    const db = await factoryOwnedBy(UID);
    const { sw, shown } = fakeSw({ factory: db.factory });
    vi.mocked(sw.registration.getNotifications).mockRejectedValueOnce(new Error('nope'));
    await handlePush(sw, resolvePayload());
    expect(shown).toHaveLength(1);
    db.close();
  });

  it('负载解不开：也要显示一条（userVisibleOnly），只写 App 名，按浏览器语言', async () => {
    const zh = fakeSw({ languages: ZH });
    await handlePush(zh.sw, null);
    expect(zh.shown[0]).toEqual({ title: fallbackTitle(ZH), options: { tag: FALLBACK_TAG } });
    const ko = fakeSw({ languages: ['ko-KR', 'en'] });
    await handlePush(ko.sw, { v: 9 });
    expect(ko.shown[0]?.title).toBe(fallbackTitle(['ko-KR']));
    expect(fallbackTitle(ZH)).not.toBe(fallbackTitle(['ko-KR']));
  });
});

describe('handleNotificationClick', () => {
  it('点通知本身：关通知，没有窗口就新开整页提醒', async () => {
    const { sw, opened } = fakeSw();
    const close = vi.fn();
    const r = await handleNotificationClick(sw, { data: dataFrom(payload()), close }, '');
    expect(close).toHaveBeenCalledOnce();
    expect(r).toEqual({ opened: reminderUrl('event', ID, DUE), snooze: null, done: null });
    expect(opened).toEqual([`${ORIGIN}/app/#/remind/event/${ID}?due=${DUE}`]);
  });

  it('已经开着 /app/ 的窗口：聚焦并跳过去，不新开', async () => {
    const { sw, opened, navigated } = fakeSw({ windows: [{ url: `${ORIGIN}/` }, { url: `${ORIGIN}/app/#/today` }] });
    await handleNotificationClick(sw, { data: dataFrom(payload()), close: vi.fn() }, '');
    expect(navigated).toEqual([`${ORIGIN}/app/#/remind/event/${ID}?due=${DUE}`]);
    expect(opened).toEqual([]);
  });

  it('聚焦被拒：退回新开', async () => {
    const { sw, opened } = fakeSw({ windows: [{ url: `${ORIGIN}/app/`, focus: () => Promise.reject(new Error('denied')) }] });
    await handleNotificationClick(sw, { data: dataFrom(payload()), close: vi.fn() }, '');
    expect(opened).toHaveLength(1);
  });

  it('不是我们的通知、或 data 校验不过（FE-3）：只打开 /app/，不写 pending', async () => {
    const { sw, opened } = fakeSw();
    expect(await handleNotificationClick(sw, { close: vi.fn() }, 'snooze')).toEqual({ opened: null, snooze: null, done: null });
    const bad = { user_id: UID, kind: 'event', id: `${ID}?next=//evil.example`, due_at: DUE, snooze_minutes: 10 };
    expect(await handleNotificationClick(sw, { data: bad, close: vi.fn() }, 'snooze')).toEqual({ opened: null, snooze: null, done: null });
    expect(opened).toEqual([`${ORIGIN}/app/`, `${ORIGIN}/app/`]);
  });

  it('测试通知（没有 data）：点开只进 /app/', async () => {
    const { sw, opened } = fakeSw();
    await handleNotificationClick(sw, { data: notificationOf(parsed({ v: 1, type: 'test', user_id: UID }), ZH).options.data, close: vi.fn() }, '');
    expect(opened).toEqual([`${ORIGIN}/app/`]);
  });

  it('点“推迟”：owner 一致 → 写 pending_actions（只有 id、表名、按键和时间），再打开整页提醒', async () => {
    const db = await factoryOwnedBy(UID);
    const { sw, opened } = fakeSw({ factory: db.factory });
    const r = await handleNotificationClick(sw, { data: dataFrom(payload({ kind: 'todo' })), close: vi.fn() }, 'snooze');
    expect(r).toEqual({ opened: reminderUrl('todo', ID, DUE), snooze: 'ok', done: null });
    expect(opened).toHaveLength(1);
    const rows = await db.cache?.tx([PENDING_ACTIONS], 'readonly', (tx) => tx.getAll<SwPendingAction>(PENDING_ACTIONS));
    expect(rows).toEqual([
      { id: 'pending-1', user_id: UID, row_table: 'todos', row_id: ID, action: { type: 'snooze', minutes: 10, due_at: DUE }, created_at: DUE + 500 },
    ]);
    expect(JSON.stringify(rows)).not.toContain('周会');
    db.close();
  });

  it('点“推迟”：别的账号的通知 → 不写，照样打开整页提醒', async () => {
    const db = await factoryOwnedBy(OTHER);
    const { sw, opened } = fakeSw({ factory: db.factory });
    const r = await handleNotificationClick(sw, { data: dataFrom(payload()), close: vi.fn() }, 'snooze');
    expect(r.snooze).toBe('owner_mismatch');
    expect(opened).toHaveLength(1);
    expect(await db.cache?.tx([PENDING_ACTIONS], 'readonly', (tx) => tx.getAll(PENDING_ACTIONS))).toEqual([]);
    db.close();
  });

  it('点“推迟”但本机没有库（已退出）：no_db，不建库', async () => {
    const db = await factoryOwnedBy(undefined);
    const { sw } = fakeSw({ factory: db.factory });
    const r = await handleNotificationClick(sw, { data: dataFrom(payload()), close: vi.fn() }, 'snooze');
    expect(r.snooze).toBe('no_db');
    expect(db.fake.dbs.get('planner-v4')?.stores.size ?? 0).toBe(0);
  });
});

describe('和后端 buildPayload 对拍（supabase/functions/_shared/push/payload.ts；代码审查 M3）', () => {
  const td = new TextDecoder();
  // PayloadInput 是 remind / resolve / test 的联合；resolve、test 故意多塞 title，测后端会把它丢掉，所以入参放宽后再断言
  const fromServer = (p: { type: PayloadInput['type'] } & Record<string, unknown>): unknown =>
    JSON.parse(td.decode(buildPayload({ user_id: UID, kind: 'event', id: ID, due_at: DUE, ...p } as PayloadInput)));
  const SNOOZE = { label: '10 分钟后', minutes: 10 };

  it('remind 带标题（push_show_title 开）：SW 解得开，显示服务器给的标题、正文、推迟按键', () => {
    const r = notificationOf(parsed(fromServer({ type: 'remind', title: '周会', body: '10:00', snooze: SNOOZE })), ZH);
    expect(r.title).toBe('周会');
    expect(r.options).toMatchObject({ body: '10:00', tag: TAG });
    expect(r.options.actions).toEqual([{ action: 'snooze', title: '10 分钟后' }]);
  });

  it('remind 不带标题（push_show_title 关）：照常显示 App 名 + 正文 + 推迟按键，不是兜底', async () => {
    for (const title of [undefined, null, '']) {
      const raw = fromServer({ type: 'remind', ...(title === undefined ? {} : { title }), body: '有 1 项日程', snooze: SNOOZE });
      expect(raw).not.toHaveProperty('title');
      const db = await factoryOwnedBy(UID);
      const { sw, shown } = fakeSw({ factory: db.factory });
      await handlePush(sw, raw);
      expect(shown).toHaveLength(1);
      expect(shown[0]).toMatchObject({ title: t('app.name', {}, 'zh-CN'), options: { tag: TAG, body: '有 1 项日程', data: { id: ID } } });
      expect(shown[0]?.options.tag).not.toBe(FALLBACK_TAG);
      expect(shown[0]?.options.actions).toHaveLength(1);
      db.close();
    }
  });

  it('不带标题也不带正文：照收，正文为空', () => {
    const p = parsed(fromServer({ type: 'remind' }));
    expect(p).toMatchObject({ type: 'remind', title: null, body: '', snooze: null });
  });

  it('不带标题的 remind 之后来 resolve：按同一个 tag 替换掉', async () => {
    const db = await factoryOwnedBy(UID);
    const { sw, shown, closed } = fakeSw({ factory: db.factory });
    await handlePush(sw, fromServer({ type: 'remind', body: '有 1 项日程', snooze: SNOOZE }));
    await handlePush(sw, fromServer({ type: 'resolve', title: '不该带上' }));
    expect(closed).toEqual([TAG]);
    expect(shown.map((x) => x.options.tag)).toEqual([TAG, TAG]);
    expect(shown[1]?.options.body).toBe(t('push.resolved', {}, 'zh-CN'));
    db.close();
  });

  it('test：SW 解得开，显示测试文案', () => {
    const r = notificationOf(parsed(fromServer({ type: 'test', title: '不该带上' })), ZH);
    expect(r.options).toMatchObject({ tag: TEST_TAG, body: t('push.test', {}, 'zh-CN') });
  });

  it('服务器截过的超长标题、正文（300 字、整份 ≤ 3071 字节）：SW 不再改动', () => {
    const raw = fromServer({ type: 'remind', title: '柠'.repeat(400), body: '😀'.repeat(400) }) as Record<string, string>;
    const p = parsed(raw);
    if (p.type !== 'remind') throw new Error('type');
    expect([p.title, p.body]).toEqual([raw['title'], raw['body']]);
    expect(Array.from(p.title ?? '')).toHaveLength(TEXT_MAX);
  });
});

describe('隐私记推送（B5 S2～S4、D19：负载不带内容，字由 SW 本地词典 push.vault.<event> 出）', () => {
  const td = new TextDecoder();
  it('四种事件和后端一字不差；中文、韩文每种都有字', () => {
    expect([...VAULT_PUSH_EVENTS]).toEqual([...SERVER_VAULT_EVENTS]);
    for (const e of VAULT_PUSH_EVENTS) {
      expect(VAULT_PUSH_TEXT.zh[e].length).toBeGreaterThan(0);
      expect(VAULT_PUSH_TEXT.ko[e].length).toBeGreaterThan(0);
    }
  });

  it('和后端 buildPayload 对拍：解得开；显示 App 名 + 本地文案，tag 固定、没有 data、没有按键；韩文按浏览器语言', () => {
    for (const event of VAULT_PUSH_EVENTS) {
      const raw: unknown = JSON.parse(td.decode(buildPayload({ type: 'vault', user_id: UID, event })));
      const p = parsed(raw);
      expect(p).toEqual({ v: 1, type: 'vault', user_id: UID, event });
      const zh = notificationOf(p, ZH);
      expect(zh.title).toBe(t('app.name', {}, 'zh-CN'));
      expect(zh.options).toMatchObject({ body: VAULT_PUSH_TEXT.zh[event], tag: VAULT_TAG });
      expect(zh.options.data).toBeUndefined();
      expect(zh.options.actions).toBeUndefined();
      expect(notificationOf(p, ['ko-KR']).options.body).toBe(VAULT_PUSH_TEXT.ko[event]);
    }
  });

  it('不认识的事件、缺 event：解不开（走兜底）', () => {
    expect(parsePushPayload({ v: 1, type: 'vault', user_id: UID, event: 'opened' })).toBeNull();
    expect(parsePushPayload({ v: 1, type: 'vault', user_id: UID })).toBeNull();
    expect(parsePushPayload({ v: 1, type: 'vault', user_id: 'x', event: 'locked' })).toBeNull();
  });

  it('不是本机账号：只写 App 名，不带正文', async () => {
    const db = await factoryOwnedBy(OTHER);
    const { sw, shown } = fakeSw({ factory: db.factory });
    await handlePush(sw, { v: 1, type: 'vault', user_id: UID, event: 'reset' });
    expect(shown).toEqual([{ title: t('app.name', {}, 'zh-CN'), options: { tag: VAULT_TAG } }]);
    db.close();
  });

  it('点开：没有 data，只打开 /app/', async () => {
    const { sw, opened } = fakeSw();
    await handleNotificationClick(sw, { data: notificationOf(parsed({ v: 1, type: 'vault', user_id: UID, event: 'locked' }), ZH).options.data, close: vi.fn() }, '');
    expect(opened).toEqual([`${ORIGIN}/app/`]);
  });
});
