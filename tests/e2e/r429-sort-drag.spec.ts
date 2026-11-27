// 长按拖动排序（R-429；R-461 整块重写：C“让位加倾斜”、6 个点摆法 1、选字三层防护；测试清单照重写方案 5.2）：
// 不要后端，往本机库 planner-v4 写好行再重新载入，用鼠标“按住 0.55 秒 → 拖 → 松手”；拖动全程逐帧记（浮层、各行 transform 和位置、选区、整页标记）
// • 待办页（R-442“待办里面不需要拖动”）：按住 0.55 秒再拖不拿起——没有浮层、顺序不变、不写 outbox、运行日志里没有 sort 行
// • 列表（按时间 → 第一次拖切到自己排）：
//   ① 拿起有过渡：浮层第一帧放大还没起来，220ms 后放大到 1.04（不是直接跳到）
//   ② 拖过两行：被越过的两行 transform 先非零（弹簧让位）、最后归零，顺序变成放下的
//   ③ 放下：从松手起逐帧看，这一行只要看得见，浮层已经撤掉、位置就是最终位置（差 ≤ 1px）
//   ⑤ 6 个点在行尾“⋯”那一格（横向和“⋯”重叠 ≥ 80%），离标题文字 ≥ 8px，“⋯”透明度为 0
//   ⑥ 选字：拖动全程选区为空、html 有 data-sort-dragging；行、输入行、底栏 computed 的 -webkit-user-select 是 none（webkit 上专看这一项：chromium 认不带前缀的，测不出这个 bug）；
//     运行日志里拖动期间没有 sel type=Range
// • ⑦ 拿起前先选中标题下那行小字：拿起后选区清空、日志 sel= 大于 0
// • ④ 瀑布流：左列一张拖到右列，放下后顺序对
// • ⑧ 减少动态效果：浮层不放大，其他行直接到位（没有一帧带 transform）
// • 电脑版（瀑布流）：换上电脑版以后照样能拖
// • 设了 LEMO_SHOT_DIR 时，Chromium 截图（430×932、DPR 3）：列表、瀑布流各一张静止、拖动中各一张；LEMO_SHOT_THEME=dark 时整组按系统深色跑、文件名带 -dark
// 隐私记页是同一个 NotesPage 组件：拖动那一条在 b5-vault.spec.ts（快读组，要假的隐私记服务）
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { cached, idbPut, idbRead, notesViewCached } from './idb.ts';
import { runLog } from './fake-media.ts';
import { expectLift, installScrub, stableBox, waitPreloaded, watchLift } from './page-helpers.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
const SHOT_DIR = process.env['LEMO_SHOT_DIR'] ?? '';
const THEME = process.env['LEMO_SHOT_THEME'] ?? '';
test.use({ loggedIn: true, timezoneId: TZ, viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, locale: 'zh-CN', colorScheme: THEME.startsWith('dark') ? 'dark' : 'light' });

const todo = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null, project: '', due: null, due_time: null, done: false, important: false, priority: 'mid', rev: 1 };
const CAT_A = '0e2e0000-0000-4000-8000-00000000c461';
const CAT_B = '0e2e0000-0000-4000-8000-00000000c462';
const note = (id: string, body: string, ago: number, cat = CAT_A, ai = false) => ({
  id, user_id: FAKE_USER_ID, title: null, body, is_private: false, category_id: cat, category_source: ai ? 'ai' : 'manual', category_seen: !ai, ai_status: 'done',
  tags: [], converted_to: null, source: 'page', raw_text: '', batch_id: null, deleted_at: null, undone: false, created_at: Date.now() - ago, updated_at: 1, rev: 1,
});
const cats = [
  ['categories', cached({ id: CAT_A, name: '生活', color: 'p4', sort: 1, created_by: 'user', merged_into: null, deleted_at: null, undone: false, rev: 1 })],
  ['categories', cached({ id: CAT_B, name: '工作灵感', color: 'p2', sort: 2, created_by: 'ai', merged_into: null, deleted_at: null, undone: false, rev: 1 })],
] as const;
/** 四条（n1 最新）：带分类、AI、摘要，截图也用它 */
const NOTES = [
  note('n1', '首尔林银杏黄了\n周末带相机去拍', 60_000, CAT_A, true),
  note('n2', '牛奶、鸡蛋、面包', 120_000, CAT_A),
  note('n3', '新功能的名字想三个备选', 180_000, CAT_B, true),
  note('n4', '下周二交报销单', 240_000, CAT_B),
];

const outboxOf = async (page: Page) =>
  ((await idbRead<{ table: string; id: string; op: string }[]>(page, 'outbox', 'getAll')) ?? []).map((i) => `${i.table}:${i.id}:${i.op}`);

async function seed(page: Page, v: 'list' | 'masonry'): Promise<void> {
  await page.goto('/app/#/notes');
  await page.getByTestId('notes').waitFor({ timeout: 30000 });
  await idbPut(page, [...cats, ...notesViewCached(v), ...NOTES.map((r) => ['notes', cached(r)] as const)]);
  await page.reload();
  await page.getByTestId('notes').waitFor({ timeout: 30000 });
  // 等动画实现换上（让位靠它的 layout 动画）
  await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'ready', undefined, { timeout: 30_000 });
  await waitPreloaded(page); // 冷启动后台预加载三页跑完再量（page-helpers.ts 头注释）
  // 隐私记入口行是另下载的小块，载入后才出现、把整列往下推一行（页面原有的载入后跳动）：等它出来、第一行位置连着 300ms 不变再开始
  await page.getByTestId('vault-lockrow').waitFor({ timeout: 30000 });
  await expect.poll(() => page.evaluate(async () => {
    const top = (): number => document.querySelector('[data-sort-id]')?.getBoundingClientRect().top ?? -1;
    const a = top();
    await new Promise((r) => setTimeout(r, 300));
    return a >= 0 && a === top();
  })).toBe(true);
}

const ids = (page: Page, prefix: string) =>
  page.locator(`[data-testid^="${prefix}"]`).evaluateAll((els, p) => els.map((e) => (e.getAttribute('data-testid') ?? '').slice((p as string).length)), prefix);

/** 一帧的记录：浮层在不在、它里层的 transform 和拿起标记、每一行的 transform / 位置 / 看不看得见、选区长度、整页标记 */
interface Frame {
  t: number;
  float: boolean;
  card: string;
  up: boolean;
  rows: Record<string, { tf: string; top: number; seen: boolean }>;
  sel: number;
  drag: boolean;
}

/** 从现在起逐帧记 ms 毫秒（按下之前开始，拿起那一帧也记得到） */
function record(page: Page, ms = 20_000): Promise<void> {
  return page.evaluate((dur) => {
    const w = window as unknown as { __rec: unknown[] };
    w.__rec = [];
    const t0 = performance.now();
    const tick = (): void => {
      const f = document.querySelector<HTMLElement>('[data-testid="sort-float"]');
      const card = f?.firstElementChild as HTMLElement | null | undefined;
      const rows: Record<string, { tf: string; top: number; seen: boolean }> = {};
      for (const e of document.querySelectorAll<HTMLElement>('[data-sort-id]:not([data-state="leaving"])')) {
        const cs = getComputedStyle(e);
        rows[e.dataset['sortId'] ?? ''] = { tf: cs.transform, top: e.getBoundingClientRect().top, seen: cs.visibility === 'visible' && Number(cs.opacity) > 0.05 };
      }
      w.__rec.push({ t: performance.now() - t0, float: !!f, card: card ? getComputedStyle(card).transform : '', up: !!card?.hasAttribute('data-up'), rows, sel: (getSelection()?.toString() ?? '').length, drag: document.documentElement.hasAttribute('data-sort-dragging') });
      if (performance.now() - t0 < dur) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // “全程不选字”另用 16 ms 定时器采样（__recT）：CI 的 WebKit 渲染慢，整段拖动 rAF 只来 3 帧（#129，ci c4b44d99 第 285 行 Received 3），
    // 采样次数不能跟帧率挂钩；这一路只记选区和拖动标记，量位置、过渡的仍用上面逐帧的 __rec
    const wt = window as unknown as { __recT: unknown[] };
    wt.__recT = [];
    const iv = setInterval(() => {
      const card = document.querySelector<HTMLElement>('[data-testid="sort-float"]')?.firstElementChild;
      wt.__recT.push({ float: !!card, up: !!card?.hasAttribute('data-up'), sel: (getSelection()?.toString() ?? '').length, drag: document.documentElement.hasAttribute('data-sort-dragging') });
      if (performance.now() - t0 >= dur) clearInterval(iv);
    }, 16);
  }, ms);
}
/** 定时器那一路的采样（只有选区和拖动标记） */
const samples = (page: Page): Promise<Pick<Frame, 'float' | 'up' | 'sel' | 'drag'>[]> =>
  page.evaluate(() => (window as unknown as { __recT: Pick<Frame, 'float' | 'up' | 'sel' | 'drag'>[] }).__recT);
const frames = (page: Page): Promise<Frame[]> => page.evaluate(() => (window as unknown as { __rec: Frame[] }).__rec);
/** transform 的放大倍数（none 为 1） */
const scaleOf = (tf: string): number => (tf.startsWith('matrix(') ? Number(tf.slice(7).split(',')[0]) : 1);
const moved = (tf: string): boolean => tf !== 'none' && !/^matrix\(1, 0, 0, 1, 0, 0\)$/.test(tf);

/** 按住 from 0.55 秒，等它真拿起来 */
async function hold(page: Page, from: Locator, holdMs = 550): Promise<{ x: number; y: number }> {
  type Box = { x: number; y: number; width: number; height: number };
  let a: Box | null = null;
  await expect(async () => {
    a = await from.boundingBox();
    expect(a, '找不到行').toBeTruthy();
  }).toPass();
  // 载入后列表上面还会出东西把整列往下推（实测一次下移 61px）：等位置连着两次不变再按
  await expect.poll(async () => {
    const p = JSON.stringify(a);
    await page.waitForTimeout(150);
    a = await from.boundingBox();
    return JSON.stringify(a) === p;
  }).toBe(true);
  const box = a as Box | null;
  if (!box) throw new Error('找不到行');
  const x = box.x + box.width * 0.45;
  const y = box.y + box.height / 2;
  // 换页动画进行中整页暂时不接点按：等按下的那一点真的落在这一行上
  const id = await from.getAttribute('data-sort-id');
  await expect.poll(() => page.evaluate(([px, py]) => document.elementFromPoint(px as number, py as number)?.closest('[data-sort-id]')?.getAttribute('data-sort-id') ?? null, [x, y] as const)).toBe(id);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(holdMs);
  if (holdMs >= 400) await expect(from).toHaveAttribute('data-sort-held', '');
  return { x, y };
}

/** 从按下的那一点拖到 target 的 (fx, fy) 比例处（分几步走） */
async function moveTo(page: Page, target: Locator, fx: number, fy: number): Promise<void> {
  const b = await target.boundingBox();
  if (!b) throw new Error('找不到目标');
  await page.mouse.move(b.x + b.width * fx, b.y + b.height * fy, { steps: 14 });
  await page.waitForTimeout(450);
}

async function shot(page: Page, browserName: string, name: string): Promise<void> {
  if (!SHOT_DIR || browserName !== 'chromium') return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, `${name}${THEME ? `-${THEME}` : ''}.png`) });
}

/** ⑤ 浮层里 6 个点和“⋯”的位置、离标题文字多远、“⋯”透明度 */
function gripLook(page: Page): Promise<{ overlap: number; gap: number; who: string; moreOpacity: number; gripOpacity: number; dots: number }> {
  return page.evaluate(() => {
    const f = document.querySelector('[data-testid="sort-float"]');
    const grip = f?.querySelector<HTMLElement>('[class*="grip"]');
    const end = grip?.parentElement;
    const more = end?.querySelector<HTMLElement>('button');
    if (!f || !grip || !more || !end) return { overlap: 0, gap: 0, who: '', moreOpacity: 1, gripOpacity: 0, dots: 0 };
    const g = grip.getBoundingClientRect();
    const m = more.getBoundingClientRect();
    const overlap = Math.max(0, Math.min(g.right, m.right) - Math.max(g.left, m.left)) / g.width;
    // 标题、摘要文字最右边（不算“⋯”那一格）
    let right = 0;
    let who = '';
    const walk = document.createTreeWalker(f, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      // 左滑露出的按钮区（压在行面下面、aria-hidden）看不见，不算
      if (end.contains(n) || !(n.textContent ?? '').trim() || n.parentElement?.closest('[aria-hidden="true"]') !== f) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      // 省略号截掉的字不算：右边界取到最近一层裁切（overflow 不是 visible）的祖先为止
      let clip = Infinity;
      for (let p: HTMLElement | null = n.parentElement; p && p !== f; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') clip = Math.min(clip, p.getBoundingClientRect().right);
      for (const b of r.getClientRects()) {
        if (b.width > 0 && b.top < g.bottom && b.bottom > g.top && Math.min(b.right, clip) > right) {
          right = Math.min(b.right, clip);
          who = (n.textContent ?? '').slice(0, 12);
        }
      }
    }
    const wrap = more.parentElement === end ? more : (more.closest(`[class*="end"] > *`) as HTMLElement | null) ?? more;
    who += ` | up=${f.firstElementChild?.hasAttribute('data-up')} end=${[...end.children].map((c) => `${c.tagName}.${c.className}:${getComputedStyle(c).opacity}`).join(',')}`;
    return { overlap, gap: g.left - right, who, moreOpacity: Number(getComputedStyle(wrap).opacity), gripOpacity: Number(getComputedStyle(grip).opacity), dots: grip.querySelectorAll('i').length };
  });
}

/** ⑥ 行、输入行、底栏 computed 的 -webkit-user-select */
function userSelects(page: Page, rowId: string): Promise<string[]> {
  return page.evaluate((rid) => ['[data-sort-id="' + rid + '"]', '[data-testid="notes-input"]', '[data-testid="tabbar"]'].map((s) => {
    const el = document.querySelector(s);
    return el ? `${s}=${getComputedStyle(el).getPropertyValue('-webkit-user-select')}` : `${s}=missing`;
  }), rowId);
}

test.describe('长按拖动排序（R-429、R-461）', () => {
  // 载入后要等隐私记入口行、位置稳定，再逐帧记；webkit 机器忙时 30 秒不够
  test.setTimeout(60_000);
  // 失败时把运行日志里拖动、左滑那几行打出来（先看日志定根因）
  test.afterEach(async ({ page }, info) => {
    if (info.status !== info.expectedStatus) {
      const lines = (await runLog(page).catch(() => [])).filter((l) => /sort|swipe|hdrag|sel| route | down | up | click /.test(l)).slice(-60);
      console.log(`地址 ${page.url()}\n${lines.join('\n')}`);
    }
  });

  test('R-442 待办页：一组里按 H → M → L 排；长按再拖不拿起、不改顺序、不写', async ({ page }) => {
    await page.goto('/app/#/todos');
    await page.waitForLoadState('domcontentloaded');
    const today = await page.evaluate((tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), TZ);
    await idbPut(page, [
      { ...todo, id: 't1', title: '低：给猫买猫砂', due: today, priority: 'low', created_at: 1 },
      { ...todo, id: 't2', title: '高：交报销单', due: today, priority: 'high', created_at: 2 },
      { ...todo, id: 't3', title: '中：准备提纲', due: today, priority: 'mid', created_at: 3 },
    ].map((r) => ['todos', cached(r)] as const));
    await page.reload();
    const row = (id: string) => page.getByTestId(`todos-row-${id}`);
    await row('t1').waitFor({ timeout: 30000 });
    const order = () => page.getByTestId('todos-g-today').locator('[data-testid^="todos-row-"]').evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').slice(10)));
    await expect.poll(order).toEqual(['t2', 't3', 't1']);
    await expect(page.locator('[data-sort-id]')).toHaveCount(0);
    // 等两行位置停稳再量（stableBox）：ci #509 webkit 第一次跑到这里 boundingBox 拿到 null（行已在 DOM、顺序已对，那一刻没有框），重试通过；
    // 慢机上今天页、待办页晚到的块会把行挤一下，量早了按不准，和列表那几条用同一个 helper
    const a = await stableBox(row('t1'));
    const b = await stableBox(row('t2'));
    await page.mouse.move(a.x + a.width * 0.45, a.y + a.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(550);
    await page.mouse.move(b.x + b.width * 0.45, b.y + 2, { steps: 12 });
    await expect(page.getByTestId('sort-float')).toHaveCount(0);
    await page.mouse.up();
    await page.waitForTimeout(300);
    expect(await order()).toEqual(['t2', 't3', 't1']);
    expect((await outboxOf(page)).filter((x) => x.startsWith('todos:'))).toEqual([]);
    expect((await runLog(page)).filter((l) => l.includes('sort todos'))).toEqual([]);
  });

  test('列表：拿起有过渡、让位、6 个点在行尾、全程不选字；放下不跳、切到自己排；设置里切回按时间', async ({ page, browserName }) => {
    await seed(page, 'list');
    const row = (id: string) => page.getByTestId(`notes-row-${id}`);
    await row('n1').waitFor({ timeout: 30000 });
    expect(await ids(page, 'notes-row-')).toEqual(['n1', 'n2', 'n3', 'n4']);
    await shot(page, browserName, '列表-静止');
    // 按下一行不出系统的半透明灰框（11-17）：Chromium 读得到 computed 值；桌面 WebKit 读到空，iPhone 只能真机看
    const hl = await row('n1').locator('button[data-open]').evaluate((e) => getComputedStyle(e).getPropertyValue('-webkit-tap-highlight-color'));
    expect(['', 'rgba(0, 0, 0, 0)']).toContain(hl);
    const logBefore = (await runLog(page)).length;

    await installScrub(page);
    const lift = watchLift(page);
    await record(page);
    await hold(page, row('n4'));
    await expectLift(lift);
    // ⑤ 6 个点在行尾“⋯”那一格。“⋯”淡出、6 个点淡入是 --dur-ui（220 ms）的过渡：等它走完再量，不写死等 300 ms
    // （11-18 CI webkit 掉帧，等了 300 ms 读到的还是起点值 1 / 0，run 44168443536）
    await expect.poll(async () => { const v = await gripLook(page); return v.moreOpacity < 0.05 && v.gripOpacity > 0.95; }, { timeout: 3000 }).toBe(true);
    const g = await gripLook(page);
    expect(g.dots).toBe(6);
    expect(g.overlap).toBeGreaterThanOrEqual(0.8);
    expect(g.gap, g.who).toBeGreaterThanOrEqual(8);
    expect(g.moreOpacity, g.who).toBeLessThan(0.05);
    expect(g.gripOpacity).toBeGreaterThan(0.95);
    // ② n4 拖到 n2 上半截（越过 n3、n2 两行）
    await moveTo(page, row('n2'), 0.45, 0.3);
    expect(await ids(page, 'notes-row-')).toEqual(['n1', 'n4', 'n2', 'n3']);
    // ⑥ 行、输入行、底栏都不能选字
    for (const u of await userSelects(page, 'n2')) expect(u).toMatch(/=none$/);
    await shot(page, browserName, '列表-拖动中');
    await page.mouse.up();
    await expect(page.getByTestId('notes-moved-toast')).toContainText('已切到自己排，设置里可改回');
    await page.waitForTimeout(1500);

    const fr = await frames(page);
    const lifted = fr.filter((x) => x.float);
    // ① 拿起有过渡：拿起那一刻还没放大（上面 expectLift 按过渡进度量，不靠帧率，#129），之后放大到 1.04
    expect(Math.max(...lifted.map((x) => scaleOf(x.card)))).toBeGreaterThan(1.035);
    // ② 被越过的两行先让位（transform 非零）、最后归零
    for (const id of ['n2', 'n3']) {
      expect(fr.some((x) => moved(x.rows[id]?.tf ?? 'none')), `${id} 没有让位动画`).toBe(true);
      expect(moved(fr.at(-1)?.rows[id]?.tf ?? 'none'), `${id} 最后没归零`).toBe(false);
    }
    // ⑥ 拖动全程选区为空、整页有标记
    // 用定时器那一路采样数（16 ms 一次，不跟 CI WebKit 的帧率走）：拖动 1 秒以上，正常 60 次上下，留足余量要多于 10 次
    const smp = await samples(page);
    const dragging = smp.filter((x) => x.float && x.up);
    expect(dragging.length).toBeGreaterThan(10);
    expect(dragging.filter((x) => x.sel > 0 || !x.drag)).toEqual([]);
    // ③ 松手以后：这一行只要看得见，浮层已经撤掉、位置就是最终位置
    // 从原行藏起来那一帧起看（拿起那一帧浮层刚挂上、原行下一次渲染才藏，两者完全重合）
    const seen = fr.slice(fr.findIndex((x) => x.float && !x.rows['n4']?.seen)).filter((x) => x.rows['n4']?.seen);
    const final = seen.at(-1)?.rows['n4']?.top ?? 0;
    expect(seen.filter((x) => x.float || Math.abs((x.rows['n4']?.top ?? 0) - final) > 1), JSON.stringify(seen.slice(0, 20).map((x) => [Math.round(x.t), x.float, x.rows['n4']?.top]))).toEqual([]);
    // 日志：拿起、换位、放下、收尾；拖动期间没有选区
    await expect.poll(async () => (await runLog(page)).slice(logBefore).some((l) => / sort notes settle moved=1 /.test(l))).toBe(true);
    // 整页标记在落下收尾（settle）那一刻撤：等到 settle 再查。不按“松手后 1.5 秒”查——CI WebKit 一秒几帧，落下动画那时还没播完（ci 0b06750c 第 302 行）
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-sort-dragging'))).toBe(false);
    const lines = (await runLog(page)).slice(logBefore);
    expect(lines.some((l) => / sort notes lift i=3 n=4 view=list sel=0 us=none/.test(l)), lines.filter((l) => l.includes('sort')).join('\n')).toBe(true);
    expect(lines.filter((l) => / sort notes over i=/.test(l)).length).toBeGreaterThanOrEqual(1);
    expect(lines.some((l) => / sort notes drop i=3 to=1 n=4/.test(l))).toBe(true);
    expect(lines.filter((l) => /sel type=Range/.test(l))).toEqual([]);

    await expect.poll(() => ids(page, 'notes-row-')).toEqual(['n1', 'n4', 'n2', 'n3']);
    await expect(page.getByTestId('notes-list').locator('h2')).toHaveCount(0);
    await expect.poll(() => outboxOf(page)).toContain('notes:n4:patch');

    // 再拖一次：只说“已移动”
    await hold(page, row('n3'));
    await moveTo(page, row('n1'), 0.45, 0.2);
    await page.mouse.up();
    await expect(page.getByTestId('notes-moved-toast')).toContainText('已移动');
    await expect.poll(() => ids(page, 'notes-row-')).toEqual(['n3', 'n1', 'n4', 'n2']);

    // 设置里切回按时间：恢复按记的时刻、按天分组
    await page.goto('/app/#/settings/notes-view');
    await expect(page.getByTestId('settings-notes-order-manual')).toBeChecked();
    await page.locator('label', { has: page.getByTestId('settings-notes-order-time') }).click();
    await expect(page.getByTestId('settings-notes-order-time')).toBeChecked();
    await page.goto('/app/#/notes');
    await row('n1').waitFor({ timeout: 30000 });
    await expect.poll(() => ids(page, 'notes-row-')).toEqual(['n1', 'n2', 'n3', 'n4']);
  });

  test('拿起前已有选区：拿起时清掉，日志 sel= 大于 0', async ({ page }) => {
    await seed(page, 'list');
    const row = (id: string) => page.getByTestId(`notes-row-${id}`);
    await row('n1').waitFor({ timeout: 30000 });
    await page.evaluate(() => {
      // R-485 起 App 页全局不选字（长按选不出字），这里给这一行临时放开，造一个“拿起前已有选区”（输入框里的选区等仍可能有）
      const sub = document.querySelector('[data-testid="notes-sub"]') as HTMLElement;
      sub.style.setProperty('-webkit-user-select', 'text');
      sub.style.setProperty('user-select', 'text');
      const r = document.createRange();
      r.selectNodeContents(sub);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(r);
    });
    expect(await page.evaluate(() => getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);
    await hold(page, row('n2'));
    expect(await page.evaluate(() => getSelection()?.toString() ?? '')).toBe('');
    await page.mouse.up();
    await expect.poll(async () => (await runLog(page)).some((l) => / sort notes lift i=1 n=4 view=list sel=[1-9]\d* /.test(l))).toBe(true);
  });

  test('瀑布流：左列一张拖到右列，放下后顺序对、两列都重排', async ({ page, browserName }) => {
    await seed(page, 'masonry');
    const card = (id: string) => page.getByTestId(`notes-card-${id}`);
    await card('n1').waitFor({ timeout: 30000 });
    const left = async (id: string) => (await card(id).boundingBox())?.x ?? 0;
    // 两列：n1、n2 在左，n3、n4 在右（CSS 多列按 DOM 顺序先填满左列）
    expect(await left('n3')).toBeGreaterThan((await left('n1')) + 100);
    await shot(page, browserName, '瀑布流-静止');
    await record(page);
    await hold(page, card('n1'));
    await moveTo(page, card('n3'), 0.5, 0.6);
    expect(await ids(page, 'notes-card-')).toEqual(['n2', 'n3', 'n1', 'n4']);
    for (const u of await userSelects(page, 'n2')) expect(u).toMatch(/=none$/);
    await shot(page, browserName, '瀑布流-拖动中');
    await page.mouse.up();
    await expect(page.getByTestId('notes-moved-toast')).toContainText('已切到自己排');
    await page.waitForTimeout(1500);
    await expect.poll(() => ids(page, 'notes-card-')).toEqual(['n2', 'n3', 'n1', 'n4']);
    const fr = await frames(page);
    expect(fr.filter((x) => x.float && x.sel > 0)).toEqual([]);
    const seen = fr.slice(fr.findIndex((x) => x.float && !x.rows['n1']?.seen)).filter((x) => x.rows['n1']?.seen);
    const final = seen.at(-1)?.rows['n1']?.top ?? 0;
    expect(seen.filter((x) => x.float || Math.abs((x.rows['n1']?.top ?? 0) - final) > 1)).toEqual([]);
  });

  test('减少动态效果：浮层不放大，其他行直接到位', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await seed(page, 'list');
    const row = (id: string) => page.getByTestId(`notes-row-${id}`);
    await row('n1').waitFor({ timeout: 30000 });
    await expect(page.locator('html')).toHaveAttribute('data-rm', '1');
    await record(page);
    await hold(page, row('n3'));
    await page.waitForTimeout(300);
    await moveTo(page, row('n1'), 0.45, 0.3);
    await page.mouse.up();
    await page.waitForTimeout(800);
    const fr = await frames(page);
    expect(fr.filter((x) => x.float).every((x) => scaleOf(x.card) === 1)).toBe(true);
    // 直接到位：每一帧每一行都在某个格位上（换位那一帧 Motion 的瞬时动画晚一帧落地，还在旧格位，也算），不出现在两个格位之间
    // 格位：拿起前一套；放下切到自己排、组名没了整列上移，又一套
    const slots = [fr[0], fr.at(-1)].flatMap((x) => Object.values(x?.rows ?? {}).map((r) => r.top));
    const between = fr.flatMap((x) => ['n1', 'n2', 'n4'].filter((id) => !slots.some((s) => Math.abs((x.rows[id]?.top ?? s) - s) <= 1)).map((id) => `${Math.round(x.t)} ${id} ${x.rows[id]?.top}`));
    expect(slots.length).toBe(8);
    expect(between).toEqual([]);
    await expect.poll(() => ids(page, 'notes-row-')).toEqual(['n3', 'n1', 'n2', 'n4']);
  });

  // 电脑版布局是首屏后才换上的（外框整个换了一个元素），换上以后照样能拖（评审第 1 条：监听不能留在旧外框上）
  test.describe('电脑宽度', () => {
    test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    test('电脑版随手记（瀑布流）：换上电脑版以后照样能拖', async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', '电脑版只在桌面 Chromium 看');
      await seed(page, 'masonry');
      const card = (id: string) => page.getByTestId(`notes-card-${id}`);
      await card('n1').waitFor({ timeout: 30000 });
      // 等电脑版换上（下载完、页里空闲时才换）
      await expect.poll(() => page.evaluate(() => document.querySelector('[data-testid="notes"] [data-desk]') !== null || performance.now() > 4000)).toBe(true);
      await page.waitForTimeout(800);
      await hold(page, card('n4'));
      await moveTo(page, card('n1'), 0.5, 0.3);
      await page.mouse.up();
      await expect(page.getByTestId('notes-moved-toast')).toContainText('已切到自己排');
      await expect.poll(() => ids(page, 'notes-card-')).toEqual(['n4', 'n1', 'n2', 'n3']);
    });
  });
});
