// 电脑宽度 e2e 共用的东西：视口和会话设置、打开今天页、往本机库种随手记和今天的日程 / 待办 / 纪念日。
// web-layout.spec.ts（2026-11-24 网页版改版；11-25 起还有宽屏进出设置、设置里换层的换页量法）用；today-now-cheer.spec.ts、b2-tabbar-transition.spec.ts 借用。写本机库用 idb.ts 的
import type { Page } from '@playwright/test';
import { cached, idbPut, notesViewCached } from './idb.ts';
import { afterPageFade } from './page-helpers.ts';
import { expect, FAKE_USER_ID } from './session-fixture.ts';
import { HINT_HELD } from './visual/visual-helpers.ts';

/** 1280×820 电脑宽度、首尔时区、登录着 */
export const DESK_USE = { trace: 'off', loggedIn: true, viewport: { width: 1280, height: 820 }, isMobile: false, hasTouch: false, timezoneId: 'Asia/Seoul' } as const;

/** 这两份用例的“此刻”：钟定在首尔中午。原来按真钟算“三小时前”，夹在今天 00:00 以后，首尔 00:00～03:30 跑时已过去那条还没结束、⑫ 必红（0d093673 的 ci） */
export const B6_NOW = new Date('2026-11-12T12:00:00+09:00');
const NOW_MS = B6_NOW.getTime();

export async function openToday(page: Page): Promise<void> {
  await page.clock.setFixedTime(B6_NOW);
  await page.goto('/app/#/today');
  await expect(page.getByTestId('today-week')).toBeVisible({ timeout: 20_000 });
  await afterPageFade(page);
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
  const now = NOW_MS;
  // 用到它的用例点的是瀑布流卡片（notes-card-*）：两类设备明确写 masonry（负责人 11-18 首装默认改列表）
  const rows: [string, unknown][] = [['drafts', HINT_HELD], ...notesViewCached('masonry')];
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
  await page.reload();
}

const TZ = 'Asia/Seoul';
/** 首尔的今天往后 n 天（YYYY-MM-DD） */
export const dayAfter = (n: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(NOW_MS + n * 86_400_000));
/** 首尔的此刻往后 min 分钟的时刻（HH:MM，按 5 分钟取整；夹在今天 00:00～23:55 里） */
function hmAfter(min: number): string {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(B6_NOW).split(':').map(Number) as [number, number];
  const at = Math.min(23 * 60 + 55, Math.max(0, Math.round((h * 60 + m + min) / 5) * 5));
  return `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
}

/** 今天页的示例数据（主持人返工第 6 条）：今天的日程三条（一条已过去、一条进行中、一条稍后）、今天截止的待办两条、没赶上的一条、30 天内的纪念日两个 */
export const TODAY_IDS = { live: '0e2e0000-0000-4000-8000-0000000b6e02', todo: '0e2e0000-0000-4000-8000-0000000b6d02', late: '0e2e0000-0000-4000-8000-0000000b6d01' } as const;
/** 三小时前就结束了的那一条日程（今天页折进“已过去”一行） */
export const PAST_ID = '0e2e0000-0000-4000-8000-0000000b6e01';

/** 往本机库写今天页的示例数据（server、view 同一份服务器行），写完刷新 */
export async function seedToday(page: Page): Promise<void> {
  const now = NOW_MS;
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
  await idbPut(page, all.flatMap(([store, rs]) => rs.map((r) => [store, cached(r)] as const)));
  await page.reload();
}

/** 换页动画都放完、拿掉（fill forwards 挂着的也算没放完；无限循环的今天卡背景层不数，同 b2-tabbar-transition 的 idle） */
export const idleAll = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => document.getAnimations().filter((a) => !(a instanceof CSSTransition) && a.effect?.getTiming().iterations !== Infinity).length), { timeout: 15_000 })
    .toBe(0);

/** 一帧：整页推页标记、旧页快照几份、main 换没换，侧栏、左目录、页头、AI 栏看上去的位置、透明度、模糊、平移（连祖先） */
export interface SwapFrame {
  t: number;
  vt: boolean;
  ghosts: number;
  sameMain: boolean;
  fixed: string[];
}

export interface SwapRead {
  vt: boolean;
  ghosts: number;
  /** 旧页快照上的动画：[透明度、模糊、位移、offset] 逐帧，时长，曲线 */
  ghost: string[];
  /** 新页里带模糊的淡入（去重）：同上 */
  fade: string[];
  /** 带平移的动画（目标的描述） */
  moved: string[];
  dockAnims: number;
  /** 既不在新页（part 时是那一栏）里、也不在旧页快照上的动画几个 */
  outside: number;
  /** 给了 frames 才有：点之前一帧、点完那一下、之后每帧到 frames 毫秒 */
  frames: SwapFrame[];
}

/**
 * 点 sel，同一个任务里读这次换页的动画（同 b2-tabbar-transition.spec.ts “页签互切和日历翻月一模一样”的量法）；新页还没出来回 null。
 * part：同一页里只换打了 data-swap-part 的那一栏（宽屏设置的右边详情，负责人 11-25）：main 不换，“新页”是那一栏。
 * frames：再逐帧记 frames 毫秒（SwapFrame；先等一帧、记一帧再点）
 */
export const clickAndRead = (page: Page, sel: string, o: { part?: boolean; frames?: number } = {}): Promise<SwapRead | null> =>
  page.evaluate(
    async ({ s, part, ms }) => {
      const shown = () => [...document.querySelectorAll('main')].find((m) => m.getClientRects().length > 0) ?? null;
      const look = (el: Element | null | undefined): string => {
        if (!el) return 'none';
        let op = 1;
        const fx: string[] = [];
        for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) {
          const cs = getComputedStyle(e);
          op *= Number(cs.opacity);
          for (const v of [cs.filter, cs.translate, cs.transform]) if (v !== 'none') fx.push(v);
        }
        const r = el.getBoundingClientRect();
        return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)} op=${Math.round(op * 100) / 100} ${fx.join(' ')}`;
      };
      const frames: { t: number; vt: boolean; ghosts: number; sameMain: boolean; fixed: string[] }[] = [];
      let t0 = 0;
      let before: HTMLElement | null = null;
      const take = (): number =>
        frames.push({
          t: Math.round(performance.now() - t0),
          vt: document.documentElement.hasAttribute('data-vt'),
          ghosts: document.querySelectorAll('[data-tab-ghost]').length,
          sameMain: shown() === before,
          fixed: [
            look(document.querySelector('[data-testid="tabbar"]')),
            look(document.querySelector('main [data-testid="settings-dk-nav"]')),
            look(shown()?.firstElementChild),
            look(document.querySelector('[data-testid="chat-dock"]')),
          ],
        });
      if (ms > 0) await new Promise((r) => requestAnimationFrame(r));
      t0 = performance.now();
      before = shown();
      if (ms > 0) take();
      document.querySelector<HTMLElement>(s)?.click();
      const m = part ? (shown()?.querySelector('[data-swap-part]') ?? null) : shown();
      if (!m || (!part && m === before)) return null;
      const anims = document.getAnimations().filter((a) => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation) && a.effect instanceof KeyframeEffect && a.effect.target instanceof Element);
      const tgt = (a: Animation) => (a.effect as KeyframeEffect).target as Element;
      const spec = (a: Animation) => {
        const e = a.effect as KeyframeEffect;
        return JSON.stringify([e.getKeyframes().map((k) => [k['opacity'] ?? null, k['filter'] ?? null, k['transform'] ?? null, k['translate'] ?? null, k.offset ?? null]), Number(e.getTiming().duration), String(e.getTiming().easing)]);
      };
      // 真有位移（px 数不是 0）才算；旧页快照的 translateX(0px)（blur-swap.ts 原地换时 x 为 0）不算
      const shift = (v: unknown): boolean => (String(v ?? '').match(/-?[\d.]+(?=px|vw|%)/g) ?? []).some((n) => Number(n) !== 0);
      const moves = (a: Animation) => (a.effect as KeyframeEffect).getKeyframes().some((k) => shift(k['translate']) || shift(k['transform']));
      const dock = document.querySelector('[data-testid="chat-dock"]');
      const read = {
        vt: document.documentElement.hasAttribute('data-vt'),
        ghosts: document.querySelectorAll('[data-tab-ghost]').length,
        ghost: anims.filter((a) => tgt(a).hasAttribute('data-tab-ghost')).map(spec),
        fade: [...new Set(anims.filter((a) => m.contains(tgt(a)) && (a.effect as KeyframeEffect).getKeyframes().some((k) => String(k['filter'] ?? '').startsWith('blur('))).map(spec))].sort(),
        moved: anims.filter(moves).map((a) => `${tgt(a).tagName}.${tgt(a).className}`),
        dockAnims: dock ? anims.filter((a) => dock.contains(tgt(a)) || tgt(a).contains(dock)).length : -1,
        outside: anims.filter((a) => !m.contains(tgt(a)) && tgt(a).closest('[data-tab-ghost]') === null).length,
        frames,
      };
      if (ms > 0) {
        take();
        while (performance.now() - t0 < ms) {
          await new Promise((r) => requestAnimationFrame(r));
          take();
        }
      }
      return read;
    },
    { s: sel, part: o.part ?? false, ms: o.frames ?? 0 },
  );
