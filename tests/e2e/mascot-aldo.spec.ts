// 吉祥物 #22 小怪兽、#23 Aldo、管理员默认 #2（负责人 11-26 弹窗）：快读组跑（tests/e2e/e2e-config.ts 的 FASTREAD_ONLY_SPECS）——
// 要读管理员身份（rpc my_ai_usage）、从假后端同步待办，默认组的构建没配 /sb 地址做不到
//   ① 管理员没选过默认 #2，走私有地址、不进 SW 缓存；①b 选了小怪兽才挂，短按笑一下
//   ② Aldo 载入后从睡着走到平时；短按换形态
//   ③ 勾完待办开心、删除摇头（一步到，不经过别的表情）；④ 久不操作睡觉、按键就醒（假时钟快进）；⑤ 提醒到点来信（真时间等到整分）、按稍后直达回平时
//   ⑥ 眼睛跟着指针；⑦ 暗色模式截图
// 表情看运行日志 mascot mood（状态机每到一个表情记一行）；设了 LEMO_SHOT_DIR 时在 Chromium 上按真机尺寸存截图
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { MASCOTS } from '../../src/features/mascot/data/catalog.ts';
import { boot, opaquePoint, rid } from './mascot-helpers.ts';
import { readRunLogInPage, shot, swipeRow } from './page-helpers.ts';
import { expect, test } from './session-fixture.ts';

test.setTimeout(90_000);
test.use({ trace: 'off', timezoneId: 'Asia/Seoul', locale: 'zh-CN', viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });

const runLog = (page: Page): Promise<string> => page.evaluate(readRunLogInPage);
/** 表情驱动回报过的表情，按先后（运行日志 mascot mood） */
const moods = async (page: Page): Promise<string[]> => [...(await runLog(page)).matchAll(/mascot mood id=\d+ s=(\w+)/g)].map((m) => m[1]!);
const lastMood = async (page: Page): Promise<string | null> => (await moods(page)).at(-1) ?? null;
const tapAt = async (page: Page): Promise<void> => {
  await opaquePoint(page);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.up();
};
const todayIs = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
/** 事件后直达 target：等到 target 回报出来（不只看第一条）。它前面最多一条，且只能是空闲随机能换到的表情——
 *  随机每 8～15 秒一次，可能刚好在点之前排上、还在路上，回报落在点之后；沿环一步步走过去的话中间会有好几个（Idle 到 No 隔 4 个） */
const reachedDirect = async (page: Page, from: number, target: string): Promise<void> => {
  await expect.poll(async () => (await moods(page)).slice(from), { timeout: 10_000 }).toContain(target);
  const after = (await moods(page)).slice(from);
  const pre = after.slice(0, after.indexOf(target));
  expect(pre.length, `到 ${target} 之前：${pre.join(' → ')}`).toBeLessThanOrEqual(1);
  for (const m of pre) expect(MASCOTS['23'].moods?.random, `到 ${target} 之前：${pre.join(' → ')}`).toContain(m);
};

test('① 管理员没选过默认 #2（负责人 11-26“我默认是二号，其他人是aldo”）：走私有地址下载、不进 SW 缓存，不下 Aldo 和小怪兽', async ({ page, baseURL }) => {
  const priv: string[] = [];
  const riv: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('mascot-private')) priv.push(r.url());
    else if (/\.riv(\?|$)/.test(r.url())) riv.push(r.url());
  });
  await boot(page, baseURL, undefined, { admin: true });
  // 私有桶的文件绝不进仓库：这里拿仓库里公开的小怪兽文件当替身回给私有地址，只验加载走哪条路
  const stand = await readFile(new URL('../../src/features/mascot/assets/monster.riv', import.meta.url));
  await page.route('**/mascot-private/**', (r) =>
    r.request().url().includes('/info/') ? r.fulfill({ json: { metadata: {} } }) : r.fulfill({ body: stand, contentType: 'application/octet-stream' }),
  );
  await page.goto('/app/#/today');
  await expect(page.locator('[data-testid="mascot"]')).toHaveAttribute('data-mascot', '2', { timeout: 30_000 });
  await expect.poll(() => runLog(page), { timeout: 30_000 }).toContain('mascot ready id=2');
  expect(priv.some((u) => u.includes('/storage/v1/object/') && u.includes('mascot-private/2.riv')), priv.join(' ')).toBe(true);
  expect(riv, '不下公开的 Aldo、小怪兽').toEqual([]);
  // SW 的各个缓存里都没有 #2
  const cached = await page.evaluate(async () => {
    const out: string[] = [];
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(r.url);
    return out;
  });
  expect(cached.filter((u) => u.includes('mascot-private') || u.includes('2.riv'))).toEqual([]);
  await expect(page.locator('[data-testid="mascot"]')).toHaveAttribute('data-mascot', '2');
});

test('①b 小怪兽 #22 是可选的第 8 个：选了才挂；短按笑一下、不进助手', async ({ page, baseURL }, info) => {
  await boot(page, baseURL, '22');
  await page.goto('/app/#/today');
  await expect(page.locator('[data-testid="mascot"]')).toHaveAttribute('data-mascot', '22', { timeout: 30_000 });
  await opaquePoint(page);
  await shot(page, info.project.name, 'monster-today', { settleMs: 1500 });
  await tapAt(page);
  await expect.poll(() => runLog(page), { timeout: 5000 }).toContain('mascot tap id=22');
  await shot(page, info.project.name, 'monster-giggle', { settleMs: 400 });
  await expect(page.getByTestId('chat-composer')).toHaveCount(0);
});

test('② Aldo：载入后从睡着走到平时；短按一下换一个形态（六个循环），不进助手', async ({ page, baseURL }, info) => {
  await boot(page, baseURL);
  await page.goto('/app/#/today');
  await expect(page.locator('[data-testid="mascot"]')).toHaveAttribute('data-mascot', '23', { timeout: 30_000 }); // 没选过的先等管理员身份（最多 2 秒）才挂；和 ①、①b 一样等 30 秒（机器忙时 WebKit 启动到挂上要 20 秒出头）
  await expect.poll(() => lastMood(page), { timeout: 30_000 }).toBe('Idle');
  await shot(page, info.project.name, 'aldo-form0', { settleMs: 1200 });
  for (const n of [1, 2, 3, 4, 5, 0]) {
    await tapAt(page);
    await expect.poll(() => runLog(page), { timeout: 5000 }).toMatch(new RegExp(`mascot form id=23 n=${n}(?!\\d)`));
    if (n !== 0) await shot(page, info.project.name, `aldo-form${n}`, { settleMs: 1200 });
  }
  await expect(page.getByTestId('chat-composer')).toHaveCount(0);
});

test('③ Aldo：勾完待办开心，删除摇头，都一步到', async ({ page, baseURL }, info) => {
  const day = todayIs();
  await boot(page, baseURL, undefined, { todos: [{ id: rid(11), title: '买牛奶', due: day }, { id: rid(12), title: '写周报', due: day }] });
  await page.goto('/app/#/today');
  await page.getByTestId(`today-row-${rid(11)}`).waitFor({ timeout: 30_000 });
  await expect.poll(() => lastMood(page), { timeout: 30_000 }).toBe('Idle');
  // 挂上后 1.2 秒内的变化当同步不反应（hooks/useMascotReactions.ts 的 SETTLE_MS），等过了再勾
  await page.waitForTimeout(1500);
  // 素材里有直达通道：事件后一步到目标，中间不经过别的表情（见 reachedDirect）
  let from = (await moods(page)).length;
  await page.locator(`[data-testid="today-done-${rid(11)}"]:not([data-state="leaving"] *)`).click();
  await reachedDirect(page, from, 'Happy');
  await shot(page, info.project.name, 'aldo-happy', { settleMs: 300 });
  from = (await moods(page)).length;
  await swipeRow(page, `today-swipe-${rid(12)}`);
  await expect(page.getByTestId(`today-row-${rid(12)}`)).toHaveCount(0);
  await reachedDirect(page, from, 'No');
  await shot(page, info.project.name, 'aldo-no', { settleMs: 300 });
});

test('④ Aldo：久不操作睡觉、按一下键就醒（假时钟快进）', async ({ page, baseURL }, info) => {
  await page.clock.install();
  await boot(page, baseURL);
  await page.goto('/app/#/today');
  await expect.poll(() => lastMood(page), { timeout: 30_000 }).toBe('Idle');
  await page.clock.fastForward(61_000);
  await expect.poll(() => lastMood(page), { timeout: 10_000 }).toBe('Sleep');
  await shot(page, info.project.name, 'aldo-sleep', { settleMs: 300 });
  await page.keyboard.press('Shift');
  await expect.poll(() => lastMood(page), { timeout: 10_000 }).toBe('Idle');
});

// 提醒不用假时钟：App 的时间按服务器响应头 Date 校正（platform/clock.ts），快进以后假后端的 Date 还是真时间，会把“现在”拉回去、到点也不响
test('⑤ Aldo：提醒到点来信，按钮条出来；按稍后直达回平时', async ({ page, baseURL }, info) => {
  test.setTimeout(150_000);
  // 只有“稍后”时刻的待办：到点就响（reminders/data/reminder-model.ts 的 rawDueAt）；引擎每整分钟算一次，放在至少 20 秒以后的整分
  const due = Math.ceil((Date.now() + 20_000) / 60_000) * 60_000;
  await boot(page, baseURL, undefined, { todos: [{ id: rid(21), title: '交材料', due: null, snooze_at: due }] });
  await page.goto('/app/#/today');
  await expect.poll(() => lastMood(page), { timeout: 30_000 }).toBe('Idle');
  // 今天页不出顶部横幅：“现在”卡原地变成这条提醒、下方出按钮条（reminders/ui/RemindHost.tsx 文件头）
  await expect(page.getByTestId('remind-bar')).toBeVisible({ timeout: due - Date.now() + 15_000 });
  await expect.poll(() => lastMood(page), { timeout: 15_000 }).toBe('Mail');
  await shot(page, info.project.name, 'aldo-mail', { settleMs: 300 });
  // 按“稍后”处理完：直达回 Idle，中间不经过 Upset（负责人 11-26）
  const from = (await moods(page)).length;
  await page.getByTestId('remind-act-snooze10').click();
  await expect.poll(() => lastMood(page), { timeout: 10_000 }).toBe('Idle');
  expect((await moods(page)).slice(from)[0]).toBe('Idle');
});

/** 画布里深色像素（眼睛、嘴）的横向重心，屏幕坐标 */
const darkX = (page: Page): Promise<number> => page.evaluate(() => {
  const c = document.querySelector<HTMLCanvasElement>('[data-testid="mascot"] canvas')!;
  const g = c.getContext('2d')!;
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let sx = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4 * 3) {
    if ((d[i + 3] ?? 0) > 200 && (d[i] ?? 255) < 80 && (d[i + 1] ?? 255) < 80 && (d[i + 2] ?? 255) < 80) {
      sx += (i / 4) % c.width;
      n += 1;
    }
  }
  const b = c.getBoundingClientRect();
  return n === 0 ? NaN : b.left + (sx / n / c.width) * b.width;
});

test('⑥ Aldo 眼睛跟着指针：指针在左边时五官偏左，在右边时偏右', async ({ page, baseURL }, info) => {
  await boot(page, baseURL);
  await page.goto('/app/#/today');
  await expect.poll(() => lastMood(page), { timeout: 30_000 }).toBe('Idle');
  const box = (await page.locator('[data-testid="mascot"] canvas').boundingBox())!;
  const cy = box.y + box.height * 0.45;
  await page.mouse.move(box.x + box.width * 0.2, cy, { steps: 4 });
  await page.waitForTimeout(900);
  const left = await darkX(page);
  await shot(page, info.project.name, 'aldo-look-left', { settleMs: 0 });
  await page.mouse.move(box.x + box.width * 0.8, cy, { steps: 8 });
  await page.waitForTimeout(900);
  const right = await darkX(page);
  await shot(page, info.project.name, 'aldo-look-right', { settleMs: 0 });
  expect(right - left, `左 ${left} 右 ${right}`).toBeGreaterThan(3);
});

test('⑦ 暗色模式：今天页 Aldo、小怪兽和设置预览', async ({ page, baseURL }, info) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await boot(page, baseURL);
  await page.goto('/app/#/today');
  await opaquePoint(page);
  await shot(page, info.project.name, 'dark-today-23', { settleMs: 1500 });
  await page.goto('/app/#/settings/mascot');
  await page.locator('label', { has: page.getByTestId('settings-mascot-22') }).click();
  await expect(page.getByTestId('mascot-preview')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await shot(page, info.project.name, 'dark-settings-22', { settleMs: 1500 });
  await page.goto('/app/#/today');
  await expect(page.locator('[data-testid="mascot"]')).toHaveAttribute('data-mascot', '22');
  await opaquePoint(page);
  await shot(page, info.project.name, 'dark-today-22', { settleMs: 1500 });
});
