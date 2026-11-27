// 今天页测量组共用（tests/perf 两份）：本机时区、灌数据、等 Service Worker 接管
import type { Page } from '@playwright/test';
import { cached, idbPut } from '../e2e/idb.ts';
import { expect, FAKE_USER_ID } from '../e2e/session-fixture.ts';

/**
 * 不用 page.clock 定钟：Playwright 的假钟连 performance.now、requestAnimationFrame 一起换掉（11-21 实测 performance.now 换成 clock.performanceNow，
 * 200 行进 DOM 记成 54 秒、FCP 取不到），量出来的时间不能用。改成挑一个“此刻是上午 9～11 点”的时区当本机时区，
 * 日程从当地今天 12:05 起排，用真钟也不会进“已过去”
 */
const ZONES = [
  'Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Sao_Paulo',
  'Atlantic/South_Georgia', 'Atlantic/Azores', 'UTC', 'Europe/Paris', 'Europe/Athens', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Dhaka',
  'Asia/Bangkok', 'Asia/Shanghai', 'Asia/Seoul', 'Australia/Brisbane', 'Pacific/Noumea', 'Pacific/Auckland', 'Pacific/Tongatapu', 'Pacific/Kiritimati',
];
const hourIn = (tz: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
export const TZ = ZONES.reduce((a, b) => (Math.abs(hourIn(b) - 10) < Math.abs(hourIn(a) - 10) ? b : a));
const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

/** 手机宽度（430×932、DPR 3，同负责人 iPhone）、登录着、上面挑的时区 */
export const PERF_USE = { loggedIn: true, timezoneId: TZ, locale: 'zh-CN', viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 } as const;

export const evId = (i: number) => `0e2e0000-0000-4000-8000-${(0xe0000 + i).toString(16).padStart(12, '0')}`;
export const tdId = (i: number) => `0e2e0000-0000-4000-8000-${(0xd0000 + i).toString(16).padStart(12, '0')}`;

/** 往本机库写 nEv 条今天的日程（当地 12:05 起每 5 分钟一条、每条 5 分钟，都还没开始）和 nTd 条今天截止、不带时刻的待办；不刷新 */
export async function seedToday(page: Page, nEv: number, nTd: number): Promise<void> {
  const at = Date.now() - 86_400_000;
  const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: at, updated_at: at, deleted_at: null, undone: false, short: null, rev: 1 };
  const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  const projects = ['工作', 'NEOX', 'SignPlex', '生活', ''];
  const rows: [string, unknown][] = [];
  for (let i = 0; i < nEv; i++) {
    rows.push(['events', cached({ ...base, id: evId(i), title: `日程 ${i + 1} 客户沟通和资料整理`, project: projects[i % 5], date: DAY, time: hm(12 * 60 + 5 + i * 5), duration_min: 5 })]);
  }
  for (let i = 0; i < nTd; i++) {
    rows.push(['todos', cached({ ...base, id: tdId(i), title: `待办 ${i + 1} 回邮件和整理清单`, project: projects[i % 5], due: DAY, due_time: null, done: false, important: false, priority: (['high', 'mid', 'low'] as const)[i % 3] })]);
  }
  await idbPut(page, rows);
}

/**
 * 重新载入到 Service Worker 接管为止，再等 3 秒：第一次打开时 SW 正在装、预先缓存所有分包，11-21 实测这一次帧与帧之间能停 26 秒
 * （主线程却没有长于 0.4 秒的帧），量的是装 SW、不是今天页；用户平时重新打开都有 SW。装好、激活以后还要再载入一次才归它管，最多三轮
 */
export async function warmSw(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await page.reload();
    if (await page.evaluate(() => navigator.serviceWorker.controller !== null)) break;
  }
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await page.waitForTimeout(3000);
}
