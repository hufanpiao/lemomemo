// 打字条的签（ui/PlusFields.tsx、hooks/useTypeBar.ts 的 picks；方案丙 11-21）：识别填签、点签改、新建分类、提醒默认和点掉、
// 手选优先（AI 回来也只改没点过的）、手选日期不拆条、日历页默认日子、“其他日期 / 时刻”走 pickDate / pickTime 占位、待办和日程写库的字段
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { collection } from '../../../core/store.ts';
import type { WriteResult } from '../../../core/write.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import type * as Session from '../../../platform/session.ts';
import type { Writer } from '../data/capture-save.ts';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import TypeBar from '../ui/TypeBar.tsx';
import type { CallAi } from '../data/type-flow.ts';
import { renderTypeHost } from './type-host.tsx';

vi.mock('../../../platform/session.ts', async (orig) => ({ ...(await orig<typeof Session>()), readSessionId: () => 'sid-f' }));

// UTC 中午：首尔、洛杉矶都还是 11-02（周一）
const NOW = msAt('2026-11-02', 12 * 60, 'UTC');
const OK: WriteResult = { ok: true, item: null };

function setup(over: { day?: string | null; callAi?: CallAi } = {}) {
  const writer = { insert: vi.fn<Writer['insert']>(async () => OK), patch: vi.fn<Writer['patch']>(async () => OK) };
  render(<TypeBar day={over.day ?? null} writer={writer} {...(over.callAi ? { callAi: over.callAi } : {})} online={() => true} onExpand={vi.fn()} onClose={vi.fn()} />);
  return { writer, input: screen.getByTestId('type-input') };
}
const type = (v: string) => fireEvent.change(screen.getByTestId('type-input'), { target: { value: v } });
const click = (el: HTMLElement) => fireEvent.click(el);
const save = async () => {
  await act(async () => {
    fireEvent.submit(screen.getByTestId('type-bar'));
  });
};
const rowOf = (w: { insert: { mock: { calls: unknown[][] } } }, n = 0) => w.insert.mock.calls[n]?.[1] as Record<string, unknown>;
const btn = (name: string) => screen.getByRole('button', { name });
const cls = (id: string) => screen.getByTestId(id).className;
/** 往本机集合塞几行（只要 id 和测试关心的列） */
const seed = (name: 'todos' | 'events' | 'settings', rows: Record<string, unknown>[]): void => collection(name).upsert(rows as { id: string }[]);

beforeEach(() => {
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  uiStore.getState().setLocale('zh-CN');
  collection('todos').clear();
  collection('events').clear();
  collection('settings').clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  collection('todos').clear();
  collection('events').clear();
  collection('settings').clear();
});

describe('识别填签', () => {
  it('没打字：三个签空着，下面一句例子；打字后认出来的画浅黄（auto），提醒有时刻默认亮', () => {
    seed('todos', [{ id: 't0', title: 'x', project: '工作', updated_at: NOW, deleted_at: null }]);
    setup();
    expect(screen.getByTestId('field-project').textContent).toBe('分类');
    expect(screen.getByTestId('field-date').textContent).toBe('日期');
    expect(screen.getByTestId('field-remind').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('试着打：明天下午3点 工作 开会 提醒我')).toBeTruthy();
    type('明天下午3点 工作 开会 提醒我');
    expect(screen.getByTestId('field-project').textContent).toBe('工作');
    expect(cls('field-project')).toMatch(/auto/);
    expect(screen.getByTestId('field-date').textContent).toBe('11/3 明天 15:00 · 1 小时');
    expect(cls('field-date')).toMatch(/auto/);
    expect(screen.getByTestId('field-remind').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('浅黄 = 从这句话里认出来的，点一下能改')).toBeTruthy();
  });

  it('日历页：没说日子时日期签写选中的那天（不上色），记下记到那天（R-353）', async () => {
    const { writer } = setup({ day: '2026-11-05' });
    type('买牛奶');
    expect(screen.getByTestId('field-date').textContent).toBe('11/5 周四');
    expect(cls('field-date')).not.toMatch(/auto|on/);
    await save();
    expect(rowOf(writer)).toMatchObject({ title: '买牛奶', due: '2026-11-05' });
  });
});

describe('点签改（手选优先）', () => {
  it('分类：展开现有分类和“不分类”，点一个选中并收起；手选盖过认出来的', async () => {
    seed('todos', [
      { id: 't0', title: 'x', project: '工作', updated_at: NOW, deleted_at: null },
      { id: 't1', title: 'x', project: '生活', updated_at: NOW, deleted_at: null },
    ]);
    const { writer } = setup();
    type('工作 交周报');
    click(screen.getByTestId('field-project'));
    expect(screen.getByTestId('tray-project')).toBeTruthy();
    expect(btn('不分类')).toBeTruthy();
    click(btn('生活'));
    expect(screen.queryByTestId('tray-project'), '点一个就收起').toBeNull();
    expect(screen.getByTestId('field-project').textContent).toBe('生活');
    expect(cls('field-project')).toMatch(/on/);
    await save();
    expect(rowOf(writer)).toMatchObject({ project: '生活' });
  });

  it('分类签和待办页项目筛选条同一份（负责人 11-22“分类里面现在不存在的不要显示，分类列表跟待办里面一样”）：删掉的、全做完的、只在日程里的不出；条数多的在前', () => {
    seed('events', [{ id: 'e0', title: 'x', project: '只在日程', date: '2026-11-01', updated_at: NOW, deleted_at: null }]);
    seed('todos', [
      { id: 't0', title: 'x', project: '工作', updated_at: NOW, deleted_at: null },
      { id: 't1', title: 'x', project: '旅游', updated_at: NOW, deleted_at: null },
      { id: 't2', title: 'x', project: '旅游', updated_at: NOW, deleted_at: null },
      { id: 't3', title: 'x', project: '删掉的', updated_at: NOW, deleted_at: NOW },
      { id: 't4', title: 'x', project: '做完的', done: true, updated_at: NOW, deleted_at: null },
    ]);
    setup();
    type('交周报');
    click(screen.getByTestId('field-project'));
    const names = [...screen.getByTestId('tray-project').querySelectorAll('button')].map((b) => b.textContent);
    expect(names).toEqual(['不分类', '旅游', '工作', '＋']);
  });

  it('分类末尾“＋”新建：回车选中、写进 project，焦点还给主输入框；“不分类”写空串', async () => {
    const { writer, input } = setup();
    type('交周报');
    click(screen.getByTestId('field-project'));
    click(screen.getByTestId('field-addproj'));
    const box = screen.getByTestId('field-newproj');
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: '学习' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByTestId('field-project').textContent).toBe('学习');
    expect(document.activeElement).toBe(input);
    expect(writer.insert, '回车不提交打字条').not.toHaveBeenCalled();
    await save();
    expect(rowOf(writer)).toMatchObject({ title: '交周报', project: '学习' });
  });

  it('日期：今天 / 明天 / 后天 / 下周一，再选时刻；待办注明没有“一段时间”；写 due、due_time，提醒默认提前 60', async () => {
    const { writer } = setup();
    type('交周报');
    click(screen.getByTestId('field-date'));
    expect(screen.getByText('待办没有“一段时间”（只有截止日）。')).toBeTruthy();
    click(btn('下周一'));
    click(btn('14:00'));
    expect(screen.getByTestId('field-date').textContent).toBe('11/9 周一 14:00');
    expect(screen.getByTestId('field-remind').getAttribute('aria-pressed')).toBe('true');
    await save();
    expect(rowOf(writer)).toMatchObject({ title: '交周报', due: '2026-11-09', due_time: '14:00', remind_before_min: 60, remind_days: null });
  });

  it('“其他日期 / 时刻”不用系统框：走 pickDate / pickTime（占位格子），选了写进签', async () => {
    const { writer } = setup();
    type('交周报');
    click(screen.getByTestId('field-date'));
    expect(document.querySelector('input[type="date"], input[type="time"]')).toBeNull();
    click(screen.getByTestId('field-otherday'));
    click(screen.getByRole('button', { name: /^11\/12/ }));
    click(screen.getByTestId('field-othertime'));
    click(within('pick-time', '20:30'));
    expect(screen.getByTestId('field-date').textContent).toBe('11/12 周四 20:30');
    await save();
    expect(rowOf(writer)).toMatchObject({ due: '2026-11-12', due_time: '20:30' });
  });

  it('提醒：有时刻默认亮，点掉就不提醒（日程 remind_min null）', async () => {
    const { writer } = setup();
    type('明天下午3点开会');
    click(screen.getByTestId('field-remind'));
    expect(screen.getByTestId('field-remind').getAttribute('aria-pressed')).toBe('false');
    await save();
    expect(writer.insert.mock.calls[0]?.[0]).toBe('events');
    expect(rowOf(writer)).toMatchObject({ time: '15:00', remind_min: null, remind_days: null });
  });

  it('没时刻的待办点亮提醒：有截止日记 remind_days 0（当天 09:00）', async () => {
    const { writer } = setup();
    type('明天交周报');
    click(screen.getByTestId('field-remind'));
    await save();
    expect(rowOf(writer)).toMatchObject({ due: '2026-11-03', due_time: null, remind_before_min: null, remind_days: 0, remind_time: '09:00' });
  });

  it('日程：有时刻选时长；全天选跨几天（清掉时刻），点亮提醒记 remind_days 0', async () => {
    const { writer } = setup();
    type('明天下午3点开会');
    click(screen.getByTestId('field-date'));
    click(btn('2 小时'));
    expect(screen.getByTestId('field-date').textContent).toBe('11/3 明天 15:00 · 2 小时');
    click(btn('全天'));
    click(btn('共 3 天'));
    expect(screen.getByTestId('field-date').textContent).toBe('11/3 明天 起 3 天');
    expect(screen.getByTestId('field-remind').getAttribute('aria-pressed'), '全天默认不提醒').toBe('false');
    click(screen.getByTestId('field-remind'));
    await save();
    expect(rowOf(writer)).toMatchObject({ title: '开会', date: '2026-11-03', time: null, duration_min: 3 * 1440, remind_min: null, remind_days: 0 });
  });

  it('手选了日期：一句话不再拆成多条', async () => {
    const { writer } = setup();
    type('买牛奶，交周报');
    click(screen.getByTestId('field-date'));
    click(btn('后天'));
    await save();
    expect(writer.insert).toHaveBeenCalledTimes(1);
    expect(rowOf(writer)).toMatchObject({ title: '买牛奶，交周报', due: '2026-11-04' });
  });

  it('AI 结果回来时只改没点过的签：点过的分类（新建的）留着，AI 给的标题、日子、时刻照用', async () => {
    seed('settings', [{ id: 'set-ai', key: 'ai.enabled', value: true, deleted_at: null, updated_at: NOW }]);
    const callAi = vi.fn(async () => ({
      intent: 'record', confidence: 1, quota_left: 3,
      items: [{ kind: 'event', title: '和小王开会', date: '2026-11-04', time: '10:00', duration_min: 60, due: null, important: false, project: null, body: null, short: 'AI', date_basis: 'rel', anniv: null, confirm: null }],
    }));
    const lines: string[] = [];
    (globalThis as unknown as Record<string, unknown>)[RL_SLOT] = { q: [], sink: (l: string) => lines.push(l) };
    const { writer } = setup({ callAi });
    type('跟小王那个会');
    click(screen.getByTestId('field-project'));
    click(screen.getByTestId('field-addproj'));
    fireEvent.change(screen.getByTestId('field-newproj'), { target: { value: '学习' } });
    fireEvent.keyDown(screen.getByTestId('field-newproj'), { key: 'Enter' });
    await save();
    // 先存、AI 后台再换（负责人 11-27）：本机拆出的当场存（手选的分类已盖上），AI 回来换成 AI 的结果、手选的照样留着
    await waitFor(() => expect(lines.some((l) => l.startsWith('typebar tidy'))).toBe(true));
    expect(callAi).toHaveBeenCalledTimes(1);
    delete (globalThis as unknown as Record<string, unknown>)[RL_SLOT];
    expect(lines.find((l) => l.startsWith('typebar planned')), '先存的是本机规则的').toMatch(/ai=later .*origin=rule/);
    expect(rowOf(writer, 0), '先存的已带上手选的分类').toMatchObject({ project: '学习' });
    expect(lines.find((l) => l.startsWith('typebar tidy')), '换成了 AI 的').toMatch(/^typebar tidy out=replaced reason=- ms=\d+$/);
    expect(lines, '点签只记哪一格').toContain('typebar pick k=project');
    expect(rowOf(writer, 1)).toMatchObject({ title: '和小王开会', date: '2026-11-04', time: '10:00', project: '学习', remind_min: 15 });
  });

  it('记下以后签清空（手选的不带到下一句）', async () => {
    const r = renderTypeHost({ day: null, writer: { insert: vi.fn(async () => OK), patch: vi.fn(async () => OK) }, online: () => true });
    type('交周报');
    click(screen.getByTestId('field-remind'));
    await save();
    r.reopen();
    expect(screen.getByTestId('field-remind').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('field-date').textContent).toBe('日期');
  });
});

describe('韩文', () => {
  it('签和展开区都有韩文', () => {
    uiStore.getState().setLocale('ko-KR');
    setup();
    expect(screen.getByTestId('field-project').textContent).toBe('분류');
    click(screen.getByTestId('field-date'));
    expect(btn('내일')).toBeTruthy();
    expect(btn('다른 날짜')).toBeTruthy();
  });
});

function within(testId: string, name: string): HTMLElement {
  const box = screen.getByTestId(testId);
  const el = [...box.querySelectorAll('button')].find((b) => b.textContent === name);
  if (!el) throw new Error(`没找到 ${name}`);
  return el;
}
