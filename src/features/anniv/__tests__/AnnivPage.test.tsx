// 纪念日页面（B5 S14；皮肤视觉稿 anniv 第 38 张）：列表按还有几天排、筛选胶囊带条数、“最近的一个”大卡、已过去的倒数日折叠、只读行点了提示；
// #/anniv/new 盖上新建一层。集合用替身；“今天”固定在 2026-11-13 10:00（current_tz）；界面语言中文
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';

type Row = { id: string } & Record<string, unknown>;
const data: { anniversaries: Row[]; settings: Row[] } = { anniversaries: [], settings: [] };
vi.mock('../../../kit/hooks/useCollection.ts', () => ({
  useCollection: (name: string) => (data as Record<string, Row[] | undefined>)[name] ?? [],
}));

const { default: AnnivPage } = await import('../ui/AnnivPage.tsx');
await (await import('../../../core/anniv-lib.ts')).loadAnnivLib();

const TZ = currentTz();
const NOW = msAt('2026-11-13', 10 * 60, TZ);
const an = (id: string, over: Record<string, unknown>): Row => ({
  id, kind: 'birthday', name: id, calendar: 'solar', lunar_variant: 'cn', month: 1, day: 1, is_leap: false, year: null, after_due: 'archive',
  remind_offsets: null, remind_time: null, avatar_id: null, created_at: Date.UTC(2026, 0, 1), deleted_at: null, undone: false, ...over,
});

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  data.settings = [];
  data.anniversaries = [
    an('김지민', { month: 11, day: 16, year: 1997 }),
    an('结婚纪念日', { kind: 'anniversary', month: 11, day: 22, year: 2020 }),
    an('上线', { kind: 'countdown', month: 11, day: 30, year: 2026 }),
    an('考试', { kind: 'countdown', month: 11, day: 1, year: 2026 }),
    an('外婆', { calendar: 'lunar', lunar_variant: 'kr', month: 3, day: 10 }),
  ];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const open = (hash: string) => {
  window.history.replaceState(null, '', `/app/${hash}`);
  return render(<AnnivPage />);
};

describe('纪念日列表', () => {
  it('按还有几天排，只读行最后；筛选胶囊带条数；最近的一个是 3 天后的生日；已过去的倒数日折叠', () => {
    open('#/anniv');
    const rows = within(screen.getByTestId('anniv-list')).getAllByTestId('anniv-row');
    expect(rows[0]?.textContent).toContain('김지민');
    expect(rows[1]?.textContent).toContain('结婚纪念日');
    expect(rows[2]?.textContent).toContain('上线');
    expect(rows[3]?.getAttribute('data-ro')).toBe('true');
    expect(screen.getByTestId('anniv-filter-all').textContent).toContain('4');
    expect(screen.getByTestId('anniv-filter-countdown').textContent).toContain('1');
    expect(screen.getByTestId('anniv-nearest').textContent).toContain('3');
    expect(screen.getByTestId('anniv-nearest').textContent).toContain('김지민');
    expect(screen.getByTestId('anniv-past').textContent).toContain('考试');
  });

  it('点筛选“纪念日”只剩纪念日', () => {
    open('#/anniv');
    fireEvent.click(screen.getByTestId('anniv-filter-anniversary'));
    const rows = within(screen.getByTestId('anniv-list')).getAllByTestId('anniv-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('结婚纪念日');
  });

  it('#/anniv/new 盖上新建一层，下面的列表不能点（inert）', async () => {
    open('#/anniv/new');
    expect(await screen.findByTestId('anniv-edit-layer')).toBeTruthy();
    expect(screen.getByTestId('anniv-page').hasAttribute('inert')).toBe(true);
    await act(async () => undefined);
  });
});

// 第三方审查前端第 1 条（11-14）：编辑层输入法组字时按 Esc 不关；编辑层是 role=dialog、aria-modal，焦点圈在层里（同 smart-search FindPanel 用 Radix Dialog）；
// 提醒弹层开着时 Esc 只关弹层；Ctrl+Enter 照常关
describe('纪念日编辑层：键盘和读屏', () => {
  const layerGone = () => waitFor(() => expect(screen.queryByTestId('anniv-edit-layer')).toBeNull());

  it('输入法组字时按 Esc（isComposing、keyCode 229）不关；不组字时 Esc 关', async () => {
    open('#/anniv/new');
    const name = await screen.findByTestId('anniv-edit-name');
    name.focus();
    fireEvent.keyDown(name, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(name, { key: 'Escape', keyCode: 229 });
    await act(async () => undefined);
    expect(screen.getByTestId('anniv-edit-layer')).toBeTruthy();
    fireEvent.keyDown(name, { key: 'Escape' });
    await layerGone();
  });

  it('编辑层是 role=dialog、aria-modal=true，带名字；焦点出了层会被拉回层里', async () => {
    const outside = document.createElement('button');
    outside.textContent = '外面';
    document.body.append(outside);
    try {
      open('#/anniv/new');
      await screen.findByTestId('anniv-edit-name');
      await act(async () => undefined);
      const dlg = screen.getByRole('dialog');
      expect(dlg.getAttribute('aria-modal')).toBe('true');
      expect(dlg.getAttribute('aria-label')).toBe('新建纪念日');
      expect(within(screen.getByTestId('anniv-edit-layer')).getByRole('dialog')).toBe(dlg);
      screen.getByTestId('anniv-edit-name').focus();
      outside.focus();
      expect(dlg.contains(document.activeElement)).toBe(true);
    } finally {
      outside.remove();
    }
  });

  it('提醒弹层开着时 Esc 只关弹层、编辑层还在；Ctrl+Enter 关编辑层', async () => {
    open('#/anniv/new');
    await screen.findByTestId('anniv-edit-name');
    fireEvent.click(screen.getByTestId('anniv-edit-remind'));
    // 提醒弹层开着时编辑层被 Radix 标成读屏不读（aria-hidden），按 DOM 数
    const dialogs = () => document.querySelectorAll('[role="dialog"]').length;
    await waitFor(() => expect(dialogs()).toBe(2));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(dialogs()).toBe(1), { timeout: 3000 });
    expect(screen.getByTestId('anniv-edit-layer')).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('anniv-edit-name'), { key: 'Enter', ctrlKey: true });
    await layerGone();
  });
});
