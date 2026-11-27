// 今日运势卡和填生日那一层（负责人 11-21 定稿：卡片“八字 B 版”、填写层“丙 打年份”；参考 方案-八字-B.html）
// • 集合用替身（settings 一个可改的小仓库，改了通知订阅者）；写用替身（kit useSettingWriter 的 save 直接改这个仓库，记下调用）
// • 算法和文案是真的（FORTUNE_LIB 真下载 shared/logic/anniv/lunar-fortune.ts）；运行日志用替身，核对只记 set / clear、不记生日
// • 中韩词条占位符逐键一致；卡片和详情里不出现术语
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type * as RunLogMod from '../../../platform/run-log-api.ts';
import { fortuneKo } from '../i18n/fortune-ko.ts';
import { fortuneZh } from '../i18n/fortune-zh.ts';

type Row = { id: string; key: string; value: unknown; deleted_at: number | null; undone: boolean };
const store = vi.hoisted(() => ({ rows: [] as Row[], subs: new Set<() => void>(), none: [] as Row[] }));
const setRows = (rows: Row[]): void => {
  store.rows = rows;
  for (const f of [...store.subs]) f();
};
vi.mock('../../../kit/hooks/useCollection.ts', () => ({
  useCollection: (name: string) =>
    useSyncExternalStore(
      (f) => {
        store.subs.add(f);
        return () => store.subs.delete(f);
      },
      () => (name === 'settings' ? store.rows : store.none),
    ),
}));
const wr = vi.hoisted(() => ({ ok: true, saves: [] as [string, unknown][] }));
vi.mock('../../../kit/hooks/useSettingWriter.ts', () => ({
  useSettingWriter: () => ({
    error: false,
    save: async (key: string, value: unknown) => {
      wr.saves.push([key, value]);
      if (wr.ok) setRows([{ id: 'r1', key, value, deleted_at: null, undone: false }]);
      return wr.ok;
    },
    update: async () => true,
  }),
}));
const logs = vi.hoisted(() => [] as string[]);
/** 只看运势记的那几行（弹层的层栈另记 layer push / pop） */
const flog = (): string[] => logs.filter((l) => l.startsWith('fortune'));
vi.mock('../../../platform/run-log-api.ts', async (orig) => ({
  ...(await orig<typeof RunLogMod>()),
  rlog: (l: string) => logs.push(l),
}));

vi.mock('../../../platform/app-static.ts', () => ({ fetchAppJsonStatus: async () => ({ kind: 'missing' }) }));

const { FortuneCard } = await import('../ui/FortuneCard.tsx');
const { default: CalendarPage } = await import('../ui/CalendarPage.tsx');

const BIRTH = (v: unknown): Row => ({ id: 'r1', key: 'cal.fortune_birth', value: v, deleted_at: null, undone: false });
const open = () => render(<FortuneCard date="2026-11-21" today="2026-11-21" />);
const tap = (id: string) => fireEvent.click(screen.getByTestId(id));
/** 卡片和详情里不许出现的术语（十神、日主之类；“八字”只在没填时那一行，照参考） */
const TERMS = ['比肩', '劫财', '食神', '伤官', '偏财', '正财', '七杀', '正官', '偏印', '正印', '日主', '日元', '天干', '地支', '五行', '身强', '身弱', '用神'];

beforeEach(() => {
  store.rows = [];
  wr.ok = true;
  wr.saves.length = 0;
  logs.length = 0;
  uiStore.getState().setLocale('zh-CN');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('今日运势卡', () => {
  it('没填生日：一行字 + 黄色“填生日”按钮；点了弹出填写层，键盘先弹出，确定是灰的', async () => {
    open();
    const empty = screen.getByTestId('fortune-empty');
    expect(empty.textContent).toBe('★想按八字看每天的运势？填生日');
    tap('fortune-set');
    await screen.findByTestId('fortune-setup');
    expect(screen.getByRole('dialog').textContent).toContain('你的生日');
    expect(screen.getByTestId('fortune-keypad')).toBeTruthy();
    expect((screen.getByTestId('fortune-ok') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('fortune-clear')).toBeNull();
    expect(screen.getByTestId('fortune-setup').textContent).toContain('生日会同步到你的账号，可随时清除 · 仅供娱乐');
    expect(screen.getByTestId('fortune-res').textContent).toBe('选好年、月、日就能看');
    expect(document.querySelector('input')).toBeNull();
  });

  it('打两位 92 → 1992、键盘收起出月日时三条；选 6 月 12 日，确定后存 {y,m,d,h}、卡片变成星星 + 白话 + “本色 · 色 · 数字”', async () => {
    open();
    tap('fortune-set');
    await screen.findByTestId('fortune-keypad');
    tap('fortune-key-9');
    expect(screen.getByTestId('fortune-keypad')).toBeTruthy();
    tap('fortune-key-2');
    expect(screen.queryByTestId('fortune-keypad')).toBeNull();
    expect(screen.getByTestId('fortune-year').textContent).toBe('1992');
    tap('fortune-m-6');
    tap('fortune-d-12');
    expect(screen.getByTestId('fortune-m-6').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('fortune-h-n').getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(screen.getByTestId('fortune-res').textContent).toMatch(/^1992年6月12日 · 不知道几点你的本色：.+$/));
    tap('fortune-ok');
    await waitFor(() => expect(screen.queryByTestId('fortune-setup')).toBeNull());
    expect(wr.saves).toEqual([['cal.fortune_birth', { y: 1992, m: 6, d: 12, h: null }]]);
    const card = await screen.findByTestId('fortune-card');
    expect(card.getAttribute('data-stars')).toBe('3');
    expect(screen.getByTestId('fortune-tip').textContent).toBe('身边人和你想到一块，适合一起干活。');
    expect(screen.getByTestId('fortune-meta').textContent).toMatch(/^.+ · {2}海军蓝 · 幸运数字 1$/);
    expect(card.getAttribute('aria-label')).toContain('3 星');
    expect(flog()).toEqual(['fortune set ok=1']);
  });

  it('打 1、9 等第三四位；清空、删一位；放不下的日子变灰（2023 年 2 月没有 29～31 日）；时段可选', async () => {
    open();
    tap('fortune-set');
    await screen.findByTestId('fortune-keypad');
    for (const k of ['1', '9', '8']) tap(`fortune-key-${k}`);
    expect(screen.getByTestId('fortune-year').textContent).toBe('198·');
    tap('fortune-key-del');
    tap('fortune-key-clr');
    expect(screen.getByTestId('fortune-year').textContent).toBe('····');
    for (const k of ['2', '3']) tap(`fortune-key-${k}`);
    expect(screen.getByTestId('fortune-year').textContent).toBe('2023');
    tap('fortune-m-2');
    expect((screen.getByTestId('fortune-d-28') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('fortune-d-29') as HTMLButtonElement).disabled).toBe(true);
    tap('fortune-d-28');
    tap('fortune-h-23');
    expect(screen.getByTestId('fortune-res').textContent).toContain('2023年2月28日 · 23–1点');
    tap('fortune-ok');
    await waitFor(() => expect(wr.saves).toEqual([['cal.fortune_birth', { y: 2023, m: 2, d: 28, h: 23 }]]));
  });

  it('数字键手指一按下就算：两指重叠、按下后挪了手指（click 没来）也不丢；手点随后的 click 不重算（负责人 11-22“输入运势卡的年份的时候打字很卡”）', async () => {
    open();
    tap('fortune-set');
    await screen.findByTestId('fortune-keypad');
    const down = (k: string) => fireEvent.pointerDown(screen.getByTestId(`fortune-key-${k}`));
    // 473 日志 t=238.59/238.71：按 1 没松手就按 9，两下都只有 pointerdown
    down('1');
    down('9');
    expect(screen.getByTestId('fortune-year').textContent).toBe('19··');
    // 正常手点：pointerdown 算一次，随后 detail=1 的 click 不再算
    down('8');
    fireEvent.click(screen.getByTestId('fortune-key-8'), { detail: 1 });
    expect(screen.getByTestId('fortune-year').textContent).toBe('198·');
    down('del');
    expect(screen.getByTestId('fortune-year').textContent).toBe('19··');
  });

  it('写不进本机：弹层不关、选的保留', async () => {
    wr.ok = false;
    open();
    tap('fortune-set');
    await screen.findByTestId('fortune-keypad');
    tap('fortune-key-9');
    tap('fortune-key-2');
    tap('fortune-m-6');
    tap('fortune-d-12');
    tap('fortune-ok');
    await waitFor(() => expect(flog()).toEqual(['fortune set ok=0']));
    expect(screen.getByTestId('fortune-setup')).toBeTruthy();
    expect(screen.getByTestId('fortune-d-12').getAttribute('aria-pressed')).toBe('true');
  });

  it('点卡片出详情：四项星星、幸运色和数字、改生日，最下面“今天是你的××日 · 仅供娱乐”；卡片和详情没有术语', async () => {
    store.rows = [BIRTH({ y: 1992, m: 6, d: 12, h: null })];
    open();
    const card = await screen.findByTestId('fortune-card');
    tap('fortune-card');
    const detail = await screen.findByTestId('fortune-detail');
    const text = detail.textContent ?? '';
    for (const c of ['工作', '感情', '财运', '健康']) expect(text).toContain(c);
    expect(within(detail).getAllByRole('img')).toHaveLength(5);
    expect(text).toContain('幸运色海军蓝');
    expect(text).toContain('1幸运数字');
    expect(screen.getByTestId('fortune-edit').textContent).toBe('改生日');
    expect(detail.lastElementChild?.textContent).toMatch(/^今天是你的.+日 · 仅供娱乐，图个好心情$/);
    for (const w of TERMS) {
      expect(text).not.toContain(w);
      expect(card.textContent).not.toContain(w);
      expect(card.getAttribute('aria-label')).not.toContain(w);
    }
    tap('fortune-close');
    await waitFor(() => expect(screen.queryByTestId('fortune-detail')).toBeNull());
  });

  it('点年份重打：显示清空、选的年份也清空，确定变灰（不会显示空着却存了旧年份）；打满四位不合格时提示范围', async () => {
    store.rows = [BIRTH({ y: 1992, m: 6, d: 12, h: null })];
    open();
    await screen.findByTestId('fortune-card');
    tap('fortune-card');
    await screen.findByTestId('fortune-detail');
    tap('fortune-edit');
    await screen.findByTestId('fortune-setup');
    expect((screen.getByTestId('fortune-ok') as HTMLButtonElement).disabled).toBe(false);
    tap('fortune-year');
    expect(screen.getByTestId('fortune-year').textContent).toBe('····');
    expect((screen.getByTestId('fortune-ok') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('fortune-res').textContent).toBe('选好年、月、日就能看');
    expect(screen.getByTestId('fortune-ytip').textContent).toBe('打两位就行：92 = 1992');
    for (const k of ['2', '0', '9', '9']) tap(`fortune-key-${k}`);
    expect(screen.getByTestId('fortune-ytip').textContent).toBe('年份要在 1901～2026 之间');
    expect(screen.getByRole('alert').textContent).toBe('年份要在 1901～2026 之间');
    expect(screen.getByTestId('fortune-keypad')).toBeTruthy();
    tap('fortune-key-del');
    expect(screen.getByTestId('fortune-ytip').textContent).toBe('打两位就行：92 = 1992');
  });

  it('今天以后的日子不能填（今天 2026-11-21）：2026 年 12 月、11 月 22 日以后置灰，11 月 21 日可以', async () => {
    open();
    tap('fortune-set');
    await screen.findByTestId('fortune-keypad');
    tap('fortune-key-2');
    tap('fortune-key-6');
    expect((screen.getByTestId('fortune-m-12') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('fortune-m-11') as HTMLButtonElement).disabled).toBe(false);
    tap('fortune-m-11');
    expect((screen.getByTestId('fortune-d-22') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('fortune-d-21') as HTMLButtonElement).disabled).toBe(false);
    tap('fortune-d-21');
    expect((screen.getByTestId('fortune-ok') as HTMLButtonElement).disabled).toBe(false);
  });

  it('改生日 → 填写层：键盘先收着、多一个“清除生日”；清除后回到没填，焦点落在“填生日”上（不掉到 body），日志只记 clear', async () => {
    store.rows = [BIRTH({ y: 1992, m: 6, d: 12, h: 9 })];
    open();
    await screen.findByTestId('fortune-card');
    tap('fortune-card');
    await screen.findByTestId('fortune-detail');
    tap('fortune-edit');
    await screen.findByTestId('fortune-setup');
    expect(screen.queryByTestId('fortune-keypad')).toBeNull();
    expect(screen.getByTestId('fortune-year').textContent).toBe('1992');
    expect(screen.getByTestId('fortune-h-9').getAttribute('aria-pressed')).toBe('true');
    tap('fortune-year');
    expect(screen.getByTestId('fortune-keypad')).toBeTruthy();
    tap('fortune-clear');
    await waitFor(() => expect(screen.queryByTestId('fortune-setup')).toBeNull());
    expect(wr.saves).toEqual([['cal.fortune_birth', {}]]);
    expect(await screen.findByTestId('fortune-empty')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('fortune-set')));
    expect(flog()).toEqual(['fortune clear ok=1']);
    for (const l of flog()) expect(l).not.toMatch(/1992|\b6\b|12/);
  });

  it('取消：不存、关掉', async () => {
    open();
    tap('fortune-set');
    await screen.findByTestId('fortune-setup');
    tap('fortune-cancel');
    await waitFor(() => expect(screen.queryByTestId('fortune-setup')).toBeNull());
    expect(wr.saves).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('fortune-set')));
  });

  it('存的值不合格（同步下来的脏数据）当作没填：年份越界、月日不对、时段不是奇数、不是对象', () => {
    for (const v of [{ y: 1900, m: 1, d: 1, h: null }, { y: 2027, m: 1, d: 1, h: null }, { y: 2023, m: 2, d: 29, h: null }, { y: 1992, m: 6, d: 12, h: 2 }, '1992-06-12', {}]) {
      store.rows = [BIRTH(v)];
      const r = open();
      expect(screen.getByTestId('fortune-empty')).toBeTruthy();
      r.unmount();
    }
  });

  it('韩文界面：卡片和详情用韩文词条', async () => {
    uiStore.getState().setLocale('ko-KR');
    store.rows = [BIRTH({ y: 1992, m: 6, d: 12, h: null })];
    open();
    await screen.findByTestId('fortune-card');
    expect(screen.getByTestId('fortune-tip').textContent).toBe('주변 사람과 생각이 잘 맞아요. 함께하면 수월해요.');
    expect(screen.getByTestId('fortune-meta').textContent).toContain('네이비');
    tap('fortune-card');
    const detail = await screen.findByTestId('fortune-detail');
    expect(detail.textContent).not.toMatch(/[一-鿿]/);
    expect(screen.getByRole('dialog').getAttribute('lang')).toBe('ko');
  });

  it('没填时键盘打 2 位后的年份：今年以后的两位数算 19xx（27 → 1927），以内算 20xx（26 → 2026）', async () => {
    open();
    tap('fortune-set');
    await screen.findByTestId('fortune-keypad');
    tap('fortune-key-2');
    tap('fortune-key-7');
    expect(screen.getByTestId('fortune-year').textContent).toBe('1927');
    tap('fortune-year');
    tap('fortune-key-2');
    tap('fortune-key-6');
    expect(screen.getByTestId('fortune-year').textContent).toBe('2026');
    await act(async () => {});
  });
});

describe('日历页上的位置', () => {
  it('选中那天清单面板最上面是运势卡（按需加载），黄历宜忌卡已经删掉；标题行只写日期和星期', async () => {
    window.history.replaceState(null, '', '/app/#/cal/month/2026-11');
    render(<CalendarPage />);
    const list = screen.getByTestId('cal-day-list');
    expect(await within(list).findByTestId('fortune-empty')).toBeTruthy();
    expect(document.getElementById('cal-day-title')?.textContent ?? '').not.toContain('农历');
  });
});

describe('今日运势词条', () => {
  it('中韩两套键一样、每个键的占位符一样', () => {
    const ph = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();
    expect(Object.keys(fortuneKo).sort()).toEqual(Object.keys(fortuneZh).sort());
    for (const [k, v] of Object.entries(fortuneZh)) expect(ph(fortuneKo[k as keyof typeof fortuneKo]), k).toEqual(ph(v));
  });
});
