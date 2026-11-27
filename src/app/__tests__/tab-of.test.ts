// 底栏显示在哪些页、选中哪个页签、“＋”新建什么（B2 FA-7；代码审查 L1）
import { describe, expect, it } from 'vitest';
import { ROUTE_NAMES } from '../router.ts';
import { featureRoutes } from '../features.ts';
import { animFor, installPageAnim } from '../page-anim.ts';
import { tabBarFor } from '../tab-of.ts';

describe('tabBarFor', () => {
  // 照 LEVELS 的 bar 原样回：hold 没写（能按住说话，App 默认 true）的四页不带这一项；隐私记那行还带着 subs，只比这三项
  it('四页：今天、日历、待办、随手记；“＋”今天和日历新建日程、待办新建待办、随手记聚焦输入行', () => {
    expect(tabBarFor('today')).toEqual({ tab: 'today', add: 'event' });
    expect(tabBarFor('calendar')).toEqual({ tab: 'calendar', add: 'event' });
    expect(tabBarFor('todos')).toEqual({ tab: 'todos', add: 'todo' });
    expect(tabBarFor('notes')).toEqual({ tab: 'notes', add: 'note' }); // R-380：随手记页的“＋”聚焦输入行
  });

  it('日历月份子页 #/cal/…：选中“日历”，“＋”同样新建日程', () => {
    expect(tabBarFor('cal')).toEqual({ tab: 'calendar', add: 'event' });
    // 纪念日页和日历同一层（周 / 月 / 纪念日分段，R-372 ②）：底栏照常、选中“日历”；
    // “＋”直接新建纪念日（负责人 11-14 22:17：“在纪念日页面按+默认新建纪念日”）
    expect(tabBarFor('anniv')).toEqual({ tab: 'calendar', add: 'anniv', hold: false });
  });

  it('隐私记页归随手记页签，“＋”同随手记（B5 D14）', () => {
    expect(tabBarFor('vault')).toMatchObject({ tab: 'notes', add: 'note', hold: false }); // 按住不录音（录下的会进普通随手记）
    // 列表筛分类、最近删除照常有底栏
    expect(tabBarFor('vault', 'c')).toMatchObject({ tab: 'notes', add: 'note', hold: false });
    expect(tabBarFor('vault', 'trash')).toMatchObject({ tab: 'notes', add: 'note', hold: false });
  });

  it('隐私记记录页（新建、编辑）不出底栏，和随手记编辑页一样（11-20 记录页方向 A）', () => {
    expect(tabBarFor('vault', 'new')).toBeNull();
    expect(tabBarFor('vault', 'n-123')).toBeNull();
    expect(tabBarFor('note', 'n-123')).toBeNull();
  });

  it('隐私记记录页和别的页签之间不算页签互切（没有底栏）；隐私记列表到今天页照旧往左', () => {
    expect(animFor({ name: 'vault', params: ['n-1'] }, { name: 'today', params: [] }, false)).toBe('push');
    expect(animFor({ name: 'vault', params: [] }, { name: 'today', params: [] }, false)).toBe('fade');
  });

  it('别的页一律没有底栏（编辑、设置、提醒、回收站……）', () => {
    // 隐私记页归随手记页签（B5 D14），单独核
    const shown = new Set(['today', 'calendar', 'cal', 'anniv', 'todos', 'notes', 'vault']);
    for (const r of ROUTE_NAMES) if (!shown.has(r)) expect(tabBarFor(r), r).toBeNull();
  });
});

describe('page-anim.ts 的 animFor：切页起哪种过渡', () => {
  installPageAnim(featureRoutes);
  const r = (name: (typeof ROUTE_NAMES)[number], ...params: string[]) => ({ name, params });
  it('同一页（samePageAs 页面组）里换地址直接画；页签互切淡换；别的整页推', () => {
    for (const wide of [false, true]) {
      expect(animFor(r('calendar'), r('cal', 'week', '2026-12-07'), wide)).toBe('none');
      expect(animFor(r('anniv'), r('anniv', 'x'), wide)).toBe('none');
      expect(animFor(r('today'), r('todos'), wide)).toBe('fade');
      expect(animFor(r('notes'), r('vault'), wide)).toBe('push');
      expect(animFor(r('today'), r('event', 'new'), wide)).toBe('push');
      expect(animFor(r('event', '1'), r('event', '2'), wide)).toBe('push');
    }
  });
  it('网页版宽屏（负责人 11-25）：设置里换层（首页、二级、三级之间）只换详情那一栏', () => {
    expect(animFor(r('settings'), r('settings', 'skin'), true)).toBe('part');
    expect(animFor(r('settings', 'remind'), r('settings', 'remind', 'upcoming'), true)).toBe('part');
    expect(animFor(r('settings', 'skin'), r('settings'), true)).toBe('part');
  });
  it('网页版宽屏：设置、最近删除和有侧栏的页之间、两者之间都原地淡换，两个方向都是', () => {
    for (const p of [r('today'), r('calendar'), r('cal', 'month', '2026-11'), r('todos'), r('notes'), r('anniv'), r('vault'), r('trash', 'todos')]) {
      expect(animFor(p, r('settings'), true), p.name).toBe('fade');
      expect(animFor(r('settings', 'skin'), p, true), p.name).toBe('fade');
    }
    for (const p of [r('today'), r('notes'), r('settings'), r('settings', 'data')]) {
      expect(animFor(p, r('trash'), true), p.name).toBe('fade');
      expect(animFor(r('trash', 'notes'), p, true), p.name).toBe('fade');
    }
  });
  it('网页版宽屏：没有侧栏的页（编辑页、隐私记记录页）进出设置、最近删除照旧整页推；同一页签里的两页（随手记 ↔ 隐私记）也照旧', () => {
    expect(animFor(r('event', 'new'), r('settings'), true)).toBe('push');
    expect(animFor(r('settings'), r('vault', 'new'), true)).toBe('push');
    expect(animFor(r('trash'), r('note', 'n-1'), true)).toBe('push');
    expect(animFor(r('notes'), r('vault'), true)).toBe('push');
    expect(animFor(r('calendar'), r('anniv'), true)).toBe('push');
  });
  it('手机、窄屏：设置里换层、进出设置和最近删除都整页推', () => {
    expect(animFor(r('settings'), r('settings', 'skin'), false)).toBe('push');
    expect(animFor(r('today'), r('settings'), false)).toBe('push');
    expect(animFor(r('settings'), r('trash'), false)).toBe('push');
  });
});
