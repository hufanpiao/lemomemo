// 路由层级表（全 app 改善报告第三节第 6 块，11-20）：原来“归哪个页签、是不是主页面、父页面是谁、到这里清不清返回栈”散在
// router.ts 的 ROOTS、MAIN_TABS，tab-swipe.ts 的 MAIN、PARENT 和 parentOf 里的特例，tab-of.ts 的 TAB_OF、ADD_OF、ADD_OF_ROUTE、VAULT_BAR_SUBS 六处。
// 合成 router.ts 的 LEVELS 一张表以后，每个地址推出来的结果要和合并前逐个相同；只有一处有意改了（纪念日列表到了也清返回栈），单独列在最后
import { afterEach, describe, expect, it } from 'vitest';
import { dockOf } from '../router-levels.ts';
import { mainTabOf, parseHash, ROUTE_NAMES, stackOf, writeEntry } from '../router.ts';
import { tabBarFor } from '../tab-of.ts';
import { parentOf } from '../tab-swipe.ts';

type Bar = { tab: string; add: string; hold: boolean } | null;
/** 地址 → 合并前的结果：底栏（tabBarFor）、主页面（mainTabOf，能左右划切页签）、父页面（parentOf，栈空时左边缘往右划回哪）、到这里清不清返回栈（ROOTS） */
type Row = [href: string, bar: Bar, main: string | null, parent: string | null, root: boolean];

const b = (tab: string, add: string, hold = true): Bar => ({ tab, add, hold });
/** 合并前（main 27bf735f）各张表逐个推出来的值，手抄、不从新表算 */
const BEFORE: readonly Row[] = [
  ['#/today', b('today', 'event'), 'today', null, true],
  ['#/calendar', b('calendar', 'event'), 'calendar', null, true],
  ['#/cal/month/2026-11', b('calendar', 'event'), 'calendar', null, true],
  ['#/cal/week/2026-11-20', b('calendar', 'event'), 'calendar', null, true],
  ['#/todos', b('todos', 'todo'), 'todos', null, true],
  ['#/notes', b('notes', 'note'), 'notes', null, true],
  ['#/anniv/new', b('calendar', 'anniv', false), null, 'anniv', false],
  ['#/anniv/0b6a3c1e-0000-4000-8000-000000000001', b('calendar', 'anniv', false), null, 'anniv', false],
  ['#/vault', b('notes', 'note', false), null, 'notes', false],
  ['#/vault/c/k1', b('notes', 'note', false), null, 'notes', false],
  ['#/vault/trash', b('notes', 'note', false), null, 'notes', false],
  ['#/vault/new', null, null, 'notes', false],
  ['#/vault/n-123', null, null, 'notes', false],
  ['#/todo/new', null, null, 'todos', false],
  ['#/todo/t1', null, null, 'todos', false],
  ['#/note/new', null, null, 'notes', false],
  ['#/note/n1', null, null, 'notes', false],
  ['#/remind/todo/t1', null, null, 'today', false],
  ['#/settings', null, null, 'today', false],
  ['#/settings/ai', null, null, 'settings', false],
  ['#/settings/remind/dnd', null, null, 'settings', false],
  ['#/onboarding', null, null, null, false],
  ['#/dev-csp', null, null, null, false],
];

/** 有意改了的：纪念日列表合并前横滑当主页面、到了却不清返回栈（ROOTS 漏了它）；合并后主页面一律是根、到了就清 */
const CHANGED: readonly Row[] = [['#/anniv', b('calendar', 'anniv', false), 'calendar', null, false]];
/** 合并以后又改的（照新值写全）：最近删除直接打开时左边缘往右划回设置（同页“‹ 返回”的 backOr('settings')，负责人 11-22 核二级页边缘返回时补；合并前父页面 null，日志 skip=root） */
const LATER: readonly Row[] = [
  ['#/trash', null, null, 'settings', false],
  ['#/trash/notes', null, null, 'settings', false],
  // 日程编辑页直接打开回今天：同页“‹ 返回”的 backOr('today')（负责人 11-22“左滑是返回上一页”；合并前是日历）
  ['#/event/new', null, null, 'today', false],
  ['#/event/e1', null, null, 'today', false],
];

const rootOf = (href: string): boolean => {
  window.history.replaceState({ lemoStack: ['#/today', '#/settings'] }, '', '#/today');
  writeEntry(href, ['#/today', '#/settings']);
  return stackOf().length === 0;
};
const now = (href: string): Row => {
  const r = parseHash(href);
  // tabBarFor 照 LEVELS 原样回（11-25）：hold 没写按 App 的读法算能按住，再和合并前比
  const bar = tabBarFor(r.name, r.params[0]);
  return [href, bar && { tab: bar.tab, add: bar.add, hold: bar.hold ?? true }, mainTabOf(r), parentOf(r), rootOf(href)];
};

afterEach(() => window.history.replaceState(null, '', '#/today'));

describe('路由层级表：每个地址推出来的页签、主页面、父页面、清不清返回栈和合并前一样', () => {
  it.each(BEFORE.map((x) => [x[0], x] as const))('%s', (href, row) => {
    expect(now(href)).toEqual(row);
  });

  it('每个路由名至少核了一个地址（加了路由没加用例会在这里报）', () => {
    const seen = new Set([...BEFORE, ...CHANGED, ...LATER].map(([h]) => parseHash(h).name));
    expect(ROUTE_NAMES.filter((n) => !seen.has(n))).toEqual([]);
  });

  it('唯一改了的一处：纪念日列表到了也清返回栈（和其他主页面一样是根）；底栏、主页面、父页面照旧', () => {
    for (const [href, bar, main, parent] of CHANGED) expect(now(href)).toEqual([href, bar, main, parent, true]);
  });

  it.each(LATER.map((x) => [x[0], x] as const))('合并以后改的：%s', (href, row) => {
    expect(now(href)).toEqual(row);
  });
});

// 网页版宽屏常驻 AI 栏（2026-11-24 改版 A 方案，独立评审：原来 ChatHost 一张 DOCK 表、各页外框、App 里设置页特判三处各写一份，
// 隐私记外框让出右边却没有栏）：并进 LEVELS 的 dock，ChatHost、kit Desk 的外框、App 的侧栏都只看 dockOf
describe('dockOf：哪一页有常驻 AI 栏', () => {
  it.each([
    ['#/today', 'today'],
    ['#/calendar', 'calendar'],
    ['#/cal/week/2026-11-20', 'calendar'],
    ['#/todos', 'todos'],
    ['#/notes', 'notes'],
    ['#/anniv', 'anniv'],
    ['#/settings', 'settings'],
    ['#/settings/skin', 'settings'],
    ['#/trash', 'settings'],
    ['#/trash/notes', 'settings'],
    // 纪念日编辑层整屏盖在列表上；隐私记、编辑页、提醒页不出栏
    ['#/anniv/new', undefined],
    ['#/vault', undefined],
    ['#/note/new', undefined],
    ['#/event/new', undefined],
    ['#/remind/event/x', undefined],
  ] as const)('%s → %s', (href, want) => {
    const r = parseHash(href);
    expect(dockOf(r.name, r.params[0])).toBe(want);
  });
});
