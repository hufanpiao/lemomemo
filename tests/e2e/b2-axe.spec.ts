// TC-B2-56 后半（B2 QA 缺口 G-10）：主要页面跑 axe（WCAG 2.1 A / AA 规则）；serious、critical 判失败，minor、moderate 记进注解（主持人 11-11 定）
// axe-core 不打包进 App：测试进程读 node_modules/axe-core/axe.min.js，用 page.evaluate 注入（evaluate 走调试协议，不受页面 CSP 拦，
// 页面的 CSP 不用为测试放宽）。依赖：package.json devDependencies 的 axe-core 4.14.0（主持人 11-11 定；锁文件里本来就有，是 jsx-a11y 带进来的同一份）。
// 每页先等主界面出来、动画播完再扫；违规按 规则 id、影响、前 3 个节点 的格式写进失败信息，方便直接定位。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { reminderUrl } from '../../shared/logic/remind-route.ts';
import { expect, test } from './session-fixture.ts';

const AXE_SRC = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

interface Violation {
  id: string;
  impact: string | null;
  help: string;
  nodes: string[];
}

async function scan(page: Page): Promise<Violation[]> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  await page.evaluate(AXE_SRC);
  const r = await page.evaluate(async (tags) => {
    type Res = { violations: { id: string; impact: string | null; help: string; nodes: { target: unknown[] }[] }[]; passes: unknown[] };
    const w = window as unknown as { axe: { run: (ctx: Document, o: unknown) => Promise<Res> } };
    const res = await w.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return {
      passes: res.passes.length,
      violations: res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => JSON.stringify(n.target)) })),
    };
  }, TAGS);
  // 确实扫到了规则（不是注入失败、空页面上的“0 违规”）
  expect(r.passes, 'axe 通过的规则数').toBeGreaterThan(5);
  return r.violations;
}

const fmt = (vs: Violation[]): string => vs.map((v) => `${v.id}（${v.impact ?? '-'}）${v.help}：${v.nodes.join(' ')}`).join('\n');
const SEVERE = new Set(['serious', 'critical']);

/**
 * 扫出来还没修的 serious：页面名 → 暂时放过的规则 id；放过的出现时记进注解 axe-known。修好以后删掉那一行。
 * 现在没有：月历、周视图日期格的 label-content-name-mismatch（WCAG 2.5.3）11-11 已修，名字以看得见的字开头（ui/cal-ui.ts labelInName）
 */
const KNOWN: Readonly<Record<string, string>> = {};

/** 扫一页：serious、critical 判失败（KNOWN 里登记的放过、记注解）；其余写进注解（报告里看得到，不挡） */
async function check(page: Page, name = ''): Promise<void> {
  const vs = await scan(page);
  const known = KNOWN[name];
  const passed = vs.filter((v) => v.id === known);
  if (passed.length > 0) test.info().annotations.push({ type: 'axe-known', description: fmt(passed) });
  const minor = vs.filter((v) => !SEVERE.has(v.impact ?? '') && v.id !== known);
  if (minor.length > 0) test.info().annotations.push({ type: 'axe-minor', description: fmt(minor) });
  const severe = vs.filter((v) => SEVERE.has(v.impact ?? '') && v.id !== known);
  expect(severe, fmt(severe)).toEqual([]);
}

test.skip(({ browserName }) => browserName !== 'chromium', 'axe 规则和浏览器无关，只在 chromium 跑一次');

const PAGES: [string, string, string][] = [
  ['今天', '/app/#/today', 'main[data-feature="today"]'],
  ['月历', '/app/#/calendar', 'main[data-feature]'],
  ['周视图', '/app/#/cal/week/2026-11-12', '[data-testid="cal-week"]'],
  ['待办', '/app/#/todos', 'main[data-feature]'],
  ['随手记', '/app/#/notes', 'main[data-feature]'],
  ['设置', '/app/#/settings', 'main[data-feature="settings"]'],
  ['新建待办', '/app/#/todo/new', '[data-testid="todo-edit"]'],
  ['新建日程', '/app/#/event/new', '[data-testid="event-edit"]'],
  ['最近删除', '/app/#/trash', 'main[data-feature]'],
  ['整页提醒（找不到了）', reminderUrl('event', '0e2e0000-0000-4000-8000-0000000000c1', Date.parse('2026-11-12T15:00:00+09:00')), '[data-testid="remind-full"]'],
];

// 桌面宽度（侧栏）和手机宽度（底栏、今天页头像）各扫一遍：两种布局的组件不一样
for (const [label, viewport] of [['桌面', { width: 1280, height: 800 }], ['手机', { width: 390, height: 844 }]] as const) {
  test.describe(`登录后的主要页面（${label}宽度）`, () => {
    test.use({ loggedIn: true, timezoneId: 'Asia/Seoul', locale: 'zh-CN', viewport });
    for (const [name, url, ready] of PAGES) {
      test(`${name}：axe 没有 serious、critical`, async ({ page }) => {
        await page.goto(url);
        await expect(page.locator(ready).first()).toBeVisible({ timeout: 20_000 });
        await check(page, name);
      });
    }
  });
}

test('登录页：axe 没有 serious、critical', async ({ page }) => {
  await page.goto('/app/auth/');
  await expect(page.locator('main').first()).toBeVisible({ timeout: 20_000 });
  await check(page);
});
