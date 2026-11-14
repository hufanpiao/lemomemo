// 电脑版布局 e2e（B6）共用的东西：视口和会话设置、打开今天页、鼠标拖块、读本机库里存下的布局、截图、往本机库种随手记和今天的日程 / 待办 / 纪念日。
// b6-desk-layout.spec.ts、b6-desk-today.spec.ts 共用；today-now-cheer.spec.ts 借用 DESK_USE、idbPut、shot
import type { Locator, Page } from '@playwright/test';
import { FADE_GUARD_MS } from '../../src/motion/index.ts';
import { expect, FAKE_USER_ID } from './session-fixture.ts';
import { HINT_HELD } from './visual/visual-helpers.ts';

/** 1280×820 电脑宽度、首尔时区、登录着 */
export const DESK_USE = { trace: 'off', loggedIn: true, viewport: { width: 1280, height: 820 }, isMobile: false, hasTouch: false, timezoneId: 'Asia/Seoul' } as const;

/** 设了 LEMO_SHOT_DIR 才截评审图 */
export const SHOT_DIR = process.env['LEMO_SHOT_DIR'];

export async function openToday(page: Page): Promise<void> {
  await page.goto('/app/#/today');
  await expect(page.getByTestId('desk-panel-week')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(FADE_GUARD_MS);
}

/** 鼠标按住 from 的中心，分几步挪到 to 的中心偏下，再松手（dnd-kit 的 PointerSensor 要挪过 4px 才算拖） */
export async function drag(page: Page, from: Locator, to: Locator): Promise<void> {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error('no_box');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 4 });
  // 拿起后 dnd-kit 下一帧才量好各块位置：等原位置出了虚框（data-dragging）再挪，挪到了停一下再松手（人手拖动本来就慢得多）
  await expect(page.locator('[data-dragging]')).toHaveCount(1);
  await page.waitForTimeout(100);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height - 10, { steps: 12 });
  await page.waitForTimeout(150);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height - 6, { steps: 2 });
  await page.mouse.up();
  // dnd-kit 拖完 50 ms 内的 click 一律吞掉（防止松手那一下点到别的东西）；人手不会这么快，测试等一下再点
  await page.waitForTimeout(200);
}

/** 本机库 settings 仓里这一页布局那一行的值（JSON）；还没写进去时空串。刷新前先等它写进本机库（写进 IndexedDB 是异步的） */
export async function stored(page: Page, p: string): Promise<string> {
  return page.evaluate(
    (prefix) =>
      new Promise<string>((resolve, reject) => {
        const req = indexedDB.open('planner-v4');
        req.onerror = () => reject(new Error(String(req.error)));
        req.onsuccess = () => {
          const db = req.result;
          const all = db.transaction('settings', 'readonly').objectStore('settings').getAll();
          all.onsuccess = () => {
            db.close();
            const rows = all.result as { view?: { key?: string; value?: unknown } }[];
            const row = rows.find((r) => r.view?.key?.startsWith(prefix));
            resolve(row ? JSON.stringify(row.view?.value) : '');
          };
          all.onerror = () => reject(new Error(String(all.error)));
        };
      }),
    `layout.${p}@inst:`,
  );
}

export const inCol = (page: Page, col: number, id: string) => page.getByTestId(`desk-col-${col}`).getByTestId(`desk-panel-${id}`);

export async function shot(page: Page, browserName: string, name: string): Promise<void> {
  if (browserName !== 'chromium' || !SHOT_DIR) return;
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, animations: 'disabled' });
}

/** 往本机库 planner-v4 原样写几行（[仓名, 一行]），写完刷新：seedNotes、seedToday、today-now-cheer.spec.ts 共用 */
export async function idbPut(page: Page, rows: [string, unknown][]): Promise<void> {
  await page.evaluate(
    (all) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('planner-v4');
        req.onerror = () => reject(new Error(String(req.error)));
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction([...new Set(all.map(([s]) => s))], 'readwrite');
          for (const [store, row] of all) tx.objectStore(store).put(row);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(new Error(String(tx.error)));
        };
      }),
    rows,
  );
  await page.reload();
}

/** 本机库写几个分类和几条随手记（形状同 b4-notes-s7s8.spec.ts 的 seedCategories），“＋”气泡记成按住过（不挡侧栏旁边的“随手记”标题），写完刷新 */
export async function seedNotes(page: Page): Promise<void> {
  const cats = [
    { id: '0e2e0000-0000-4000-8000-0000000006a1', name: '工作灵感', color: '#e0a100' },
    { id: '0e2e0000-0000-4000-8000-0000000006a2', name: '韩国生活', color: '#3f8f6b' },
    { id: '0e2e0000-0000-4000-8000-0000000006a3', name: '读书', color: '#4a6fd1' },
  ];
  const texts: [string, number][] = [
    ['外国人登录证更新要带的：护照、照片 1 张、手续费 3 万韩元', 1],
    ['NEOX 片尾 logo 停留可以再短 0.5 秒，配合鼓点收尾', 0],
    ['牛奶、鸡蛋、猫砂', 1],
    ['想读：《어린 왕자》韩文版，朋友推荐的版本', 2],
    ['SignPlex 落地页标题：一次签完，不用打印', 0],
    ['延南洞那家面包店周一休息，下次周二去', 1],
  ];
  const now = Date.now();
  const rows: [string, unknown][] = [['drafts', HINT_HELD]];
  cats.forEach((c, i) => {
    const row = { ...c, sort: i + 1, created_by: 'ai', merged_into: null, deleted_at: null, undone: false, rev: 1 };
    rows.push(['categories', { id: c.id, server: row, view: row }]);
  });
  texts.forEach(([body, ci], i) => {
    const id = `0e2e0000-0000-4000-8000-0000000006b${i}`;
    const at = now - i * 3_600_000;
    const note = {
      id, title: null, body, is_private: false, category_id: cats[ci]?.id, category_source: 'ai', category_seen: true, tags: [],
      converted_to: null, source: 'page', raw_text: '', batch_id: null, created_at: at, updated_at: at,
    };
    rows.push(['notes', { id, server: null, view: note }]);
  });
  await idbPut(page, rows);
}

const TZ = 'Asia/Seoul';
/** 首尔的今天往后 n 天（YYYY-MM-DD） */
export const dayAfter = (n: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + n * 86_400_000));
/** 首尔的此刻往后 min 分钟的时刻（HH:MM，按 5 分钟取整；夹在今天 00:00～23:55 里） */
function hmAfter(min: number): string {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).split(':').map(Number) as [number, number];
  const at = Math.min(23 * 60 + 55, Math.max(0, Math.round((h * 60 + m + min) / 5) * 5));
  return `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
}

/** 今天页的示例数据（主持人返工第 6 条）：今天的日程三条（一条已过去、一条进行中、一条稍后）、今天截止的待办两条、没赶上的一条、30 天内的纪念日两个 */
export const TODAY_IDS = { live: '0e2e0000-0000-4000-8000-0000000b6e02', todo: '0e2e0000-0000-4000-8000-0000000b6d02', late: '0e2e0000-0000-4000-8000-0000000b6d01' } as const;
/** 三小时前就结束了的那一条日程（今天页折进“已过去”一行） */
export const PAST_ID = '0e2e0000-0000-4000-8000-0000000b6e01';

/** 往本机库写今天页的示例数据（server、view 同一份服务器行），写完刷新 */
export async function seedToday(page: Page): Promise<void> {
  const now = Date.now();
  const base = { user_id: FAKE_USER_ID, created_at: now - 86_400_000, updated_at: now - 86_400_000, deleted_at: null, undone: false, short: null };
  const ev = (id: string, title: string, project: string, time: string, duration_min: number) => ({ ...base, id, title, project, date: dayAfter(0), time, tz: TZ, duration_min });
  const events = [
    ev(PAST_ID, 'SignPlex 字幕校对', 'SignPlex', hmAfter(-180), 30),
    ev(TODAY_IDS.live, 'NEOX 横版对片', 'NEOX', hmAfter(-40), 90),
    ev('0e2e0000-0000-4000-8000-0000000b6e03', 'SignPlex 客户反馈会', 'SignPlex', hmAfter(80), 60),
  ];
  const td = (id: string, title: string, project: string, due: string, due_time: string | null) => ({ ...base, tz: TZ, id, title, project, due, due_time, done: false });
  const todos = [
    td(TODAY_IDS.late, '交 NEOX 片尾', 'NEOX', dayAfter(-2), null),
    td(TODAY_IDS.todo, 'NEOX 竖版 4K 导出', 'NEOX', dayAfter(0), null),
    td('0e2e0000-0000-4000-8000-0000000b6d03', '回复 박 대리 的邮件', 'SignPlex', dayAfter(0), '23:30'),
  ];
  const ymd = (s: string) => s.split('-').map(Number) as [number, number, number];
  const ab = { calendar: 'solar', lunar_variant: 'cn', is_leap: false, after_due: 'archive', remind_offsets: null, remind_time: null, avatar_id: null, note: '',
    remind_at: null, snooze_at: null, notified_for: null, archived_at: null, deleted_at: null, undone: false, rev: 1, created_at: now - 86_400_000, updated_at: now };
  const [, bm, bd] = ymd(dayAfter(3));
  const [, wm, wd] = ymd(dayAfter(9));
  const anniv = [
    { ...ab, id: '0e2e0000-0000-4000-8000-0000000b6a01', kind: 'birthday', name: '김지민', month: bm, day: bd, year: 1997, next_date: dayAfter(3) },
    { ...ab, id: '0e2e0000-0000-4000-8000-0000000b6a02', kind: 'anniversary', name: '结婚纪念日', month: wm, day: wd, year: 2020, next_date: dayAfter(9) },
  ];
  const all: [string, Record<string, unknown>[]][] = [['events', events], ['todos', todos], ['anniversaries', anniv]];
  await idbPut(page, all.flatMap(([store, rs]) => rs.map((r): [string, unknown] => [store, { id: r['id'], server: r, view: r }])));
}
