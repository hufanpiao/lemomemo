// 设置 › 日历 界面（B2 FA-3 第二段，R-97；R-320 二级页、R-321 不加农历开关）：节假日三选一、每周第一天；写经 core/write（替身）
// 二级页正文（CalendarSettings）和设置首页那一行的值（CalendarSettingsValue.tsx）都在这里测；
// 行名、整行、顶栏、路由、返回由设置页画（SETTINGS-merge-cards），在设置页的 SettingsPage.test.tsx
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';

type Row = { id: string } & Record<string, unknown>;
type Res = { ok: boolean; item?: null; reason?: string };
const data: { settings: Row[] } = { settings: [] };
vi.mock('../../../kit/hooks/useCollection.ts', () => ({
  useCollection: (name: string) => (name === 'settings' ? data.settings : []),
}));
const insert = vi.fn(async (..._a: unknown[]): Promise<Res> => ({ ok: true, item: null }));
const patch = vi.fn(async (..._a: unknown[]): Promise<Res> => ({ ok: true, item: null }));
vi.mock('../../../core/write.ts', () => ({ write: { insert: (...a: unknown[]) => insert(...a), patch: (...a: unknown[]) => patch(...a) } }));

const { default: CalendarSettings } = await import('../ui/CalendarSettings.tsx');
const { default: CalendarSettingsValue } = await import('../ui/CalendarSettingsValue.tsx');
const { viewZh } = await import('../i18n/view-zh.ts');
const { viewKo } = await import('../i18n/view-ko.ts');

const radio = (v: string) => screen.getByTestId(`settings-cal-hol-${v}`) as HTMLInputElement;
const ws = (v: 0 | 1) => screen.getByTestId(`settings-cal-ws-${v}`);

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  data.settings = [];
  insert.mockClear();
  patch.mockClear();
  insert.mockResolvedValue({ ok: true, item: null });
});
afterEach(cleanup);

describe('设置 › 日历', () => {
  it('没选过：中文界面亮“只显示中国”和“周一”，不写任何东西', () => {
    render(<CalendarSettings />);
    expect(radio('cn').checked).toBe(true);
    expect(radio('kr').checked).toBe(false);
    expect(ws(1).getAttribute('aria-pressed')).toBe('true');
    expect(ws(0).getAttribute('aria-pressed')).toBe('false');
    expect(insert).not.toHaveBeenCalled();
  });

  it('韩文界面没选过：亮“只显示韩国”和“周日”', () => {
    uiStore.getState().setLocale('ko-KR');
    render(<CalendarSettings />);
    expect(radio('kr').checked).toBe(true);
    expect(ws(0).getAttribute('aria-pressed')).toBe('true');
  });

  it('选“两国都显示”：本机没有这一行就 insert cal.holidays；选周日 insert cal.week_start = 0', async () => {
    render(<CalendarSettings />);
    await act(async () => {
      fireEvent.click(radio('both'));
    });
    expect(insert).toHaveBeenCalledWith('settings', expect.objectContaining({ key: 'cal.holidays', value: 'both', id: expect.any(String) }));
    await act(async () => {
      fireEvent.click(ws(0));
    });
    expect(insert).toHaveBeenCalledWith('settings', expect.objectContaining({ key: 'cal.week_start', value: 0 }));
  });

  it('已有那一行：显示存的值，改的时候 patch 那一行', async () => {
    data.settings = [{ id: 's1', key: 'cal.holidays', value: 'kr', deleted_at: null, undone: false }];
    render(<CalendarSettings />);
    expect(radio('kr').checked).toBe(true);
    await act(async () => {
      fireEvent.click(radio('cn'));
    });
    expect(patch).toHaveBeenCalledWith('settings', 's1', { value: 'cn' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('二级页正文：组标题 + 每项一行、选中的那行打 ✓（设计审查 M8）', () => {
    data.settings = [{ id: 's1', key: 'cal.holidays', value: 'both', deleted_at: null, undone: false }];
    render(<CalendarSettings />);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['节假日', '每周第一天']);
    const rows = screen.getAllByRole('radio').map((r) => r.closest('label'));
    expect(rows.map((l) => l?.getAttribute('data-on'))).toEqual([null, null, '1']);
    expect(rows[2]?.textContent).toContain('✓');
    expect(rows[0]?.textContent).not.toContain('✓');
  });

  it('点已经亮着的推导值也存下来（代码审查 L5）：没选过、点“只显示中国”就 insert cn', async () => {
    render(<CalendarSettings />);
    await act(async () => {
      fireEvent.click(radio('cn'));
    });
    expect(insert).toHaveBeenCalledWith('settings', expect.objectContaining({ key: 'cal.holidays', value: 'cn' }));
  });

  it('本机还没这一行时连点两次：第二次 patch 刚 insert 的那一行，不再 insert 一行（代码审查 L6）', async () => {
    render(<CalendarSettings />);
    await act(async () => {
      fireEvent.click(radio('both'));
      fireEvent.click(radio('kr'));
    });
    expect(insert).toHaveBeenCalledTimes(1);
    const id = (insert.mock.calls[0]?.[1] as { id: string }).id;
    expect(patch).toHaveBeenCalledWith('settings', id, { value: 'kr' });
  });

  it('写不进本机：提示“没保存上”', async () => {
    insert.mockResolvedValue({ ok: false, reason: 'local_unavailable' });
    render(<CalendarSettings />);
    await act(async () => {
      fireEvent.click(radio('both'));
    });
    expect(screen.getByRole('alert').textContent).toBe('没保存上，请稍后再试');
  });

  it('韩文二级页正文：공휴일、한 주의 시작（顶栏“‹ 설정 / 달력”由设置页画，测在 SettingsPage.test.tsx）', () => {
    uiStore.getState().setLocale('ko-KR');
    render(<CalendarSettings />);
    expect(screen.getByText('공휴일')).toBeTruthy();
    // B2-UI-b W1 起用 kit 设置行：卡名（只给读屏的 h2）和行名都是“한 주의 시작”，分段按钮组的名字取行名
    expect(screen.getByRole('group', { name: '한 주의 시작' })).toBeTruthy();
    expect(screen.getByTestId('settings-cal-hol-both').closest('label')?.textContent).toBe('두 나라 모두');
  });

  it('R-321：没有“显示农历”开关（不出现农历字样、只有节假日三个单选，没有勾选框和开关）', () => {
    render(<CalendarSettings />);
    const page = screen.getByTestId('settings-calendar');
    expect(page.textContent).not.toContain('农历');
    expect(page.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(page.querySelectorAll('[role="switch"]')).toHaveLength(0);
    expect(page.querySelectorAll('input[type="radio"]')).toHaveLength(3);
    expect(insert).not.toHaveBeenCalledWith('settings', expect.objectContaining({ key: 'cal.lunar' }));
  });

  it('词典里没有 cal.lunar 相关的键（R-321 不实现）', () => {
    expect(Object.keys(viewZh).filter((k) => k.toLowerCase().includes('lunar') && k !== 'cal.a11y.lunar')).toEqual([]);
  });
});

describe('设置首页的“日历”一行（R-320）', () => {
  /** 值组件只返回一段摘要文字 */
  const summary = () => document.body.textContent;

  it('中文没选过：“节假日：中国”（不写农历，负责人 11-04）；只有文字，没有按钮和标题（整行由设置页画）；不写任何东西', () => {
    render(<CalendarSettingsValue />);
    expect(summary()).toBe('节假日：中国');
    expect(summary()).not.toContain('农历');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(insert).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it.each([
    ['kr', '节假日：韩国'],
    ['both', '节假日：中国、韩国'],
    ['cn', '节假日：中国'],
  ])('中文、存的是 %s：摘要写 %s（两国时本国在前，负责人 11-04）', (v, want) => {
    data.settings = [{ id: 's1', key: 'cal.holidays', value: v, deleted_at: null, undone: false }];
    render(<CalendarSettingsValue />);
    expect(summary()).toBe(want);
  });

  it('韩文没选过：“공휴일: 한국”，不写음력（R-318）', () => {
    uiStore.getState().setLocale('ko-KR');
    render(<CalendarSettingsValue />);
    expect(summary()).toBe('공휴일: 한국');
    expect(summary()).not.toContain('음력');
  });

  it.each([
    ['cn', '공휴일: 중국'],
    ['both', '공휴일: 한국·중국'],
  ])('韩文、存的是 %s：摘要写 %s', (v, want) => {
    uiStore.getState().setLocale('ko-KR');
    data.settings = [{ id: 's1', key: 'cal.holidays', value: v, deleted_at: null, undone: false }];
    render(<CalendarSettingsValue />);
    expect(summary()).toBe(want);
  });

  it('被软删的那一行不算：按界面语言推导', () => {
    data.settings = [{ id: 's1', key: 'cal.holidays', value: 'kr', deleted_at: '2026-11-01T00:00:00Z', undone: false }];
    render(<CalendarSettingsValue />);
    expect(summary()).toBe('节假日：中国');
  });

  it('行名：中文“日历”、韩文“캘린더”（R-106 B2K-05；和设置页二级页标题同一个词，设置页那一份归前端 A 待同步，页面级核对在 SettingsPage.test.tsx，代码审查 L4）', () => {
    expect(viewZh['cal.set.title']).toBe('日历');
    expect(viewKo['cal.set.title']).toBe('캘린더');
  });

  it('韩文词典的摘要模板和中文用同一个占位符 {hol}', () => {
    expect(viewKo['cal.set.summary']).toContain('{hol}');
    expect(viewZh['cal.set.summary']).toContain('{hol}');
  });
});
