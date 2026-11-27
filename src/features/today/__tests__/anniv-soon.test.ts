// 今天页顶部的纪念日一行（B5 S14）：7 天内最近的一个，用服务器的 next_date
import { describe, expect, it } from 'vitest';
import { ANNIV_SOON_DAYS, annivLabel, annivRecent, annivUpcoming, annivWhen, type AnnivT } from '../data/anniv-soon.ts';

/** 手机纪念日一行：7 天内最近的一个 */
const annivSoon = (rows: Parameters<typeof annivUpcoming>[0], today: string) => annivUpcoming(rows, today as never, ANNIV_SOON_DAYS, 1)[0] ?? null;

const r = (id: string, x: Record<string, unknown>) => ({ id, name: id, deleted_at: null, undone: false, archived_at: null, ...x });

describe('7 天内最近的一个（annivUpcoming 取第一个）', () => {
  it('7 天内（含今天、含第 7 天）最近的一个；同一天按名字', () => {
    const rows = [r('b', { next_date: '2026-11-16' }), r('a', { next_date: '2026-11-16' }), r('far', { next_date: '2026-11-21' }), r('edge', { next_date: '2026-11-20' })];
    expect(annivSoon(rows, '2026-11-13')).toMatchObject({ row: { id: 'a' }, days: 3 });
    expect(annivSoon([rows[3] as never], '2026-11-13')?.days).toBe(7);
    expect(annivSoon([r('t', { next_date: '2026-11-13' })], '2026-11-13')?.days).toBe(0);
  });

  it('已删、撤销、已归档、没有 next_date、next_date 早于今天、超过 7 天的不出', () => {
    const rows = [
      r('d', { next_date: '2026-11-14', deleted_at: 1 }),
      r('u', { next_date: '2026-11-14', undone: true }),
      r('ar', { next_date: '2026-11-14', archived_at: 1 }),
      r('n', {}),
      r('old', { next_date: '2026-11-12' }),
      r('far', { next_date: '2026-11-21' }),
    ];
    expect(annivSoon(rows, '2026-11-13')).toBeNull();
  });
});

describe('电脑“最近的纪念日”卡（annivRecent，负责人 11-25）', () => {
  const today = '2026-11-25' as never;
  it('30 天内有几个列几个（不限 3 个），近的在前、同一天按名字；30 天外的不列', () => {
    const rows = ['2026-11-26', '2026-11-30', '2026-12-05', '2026-12-10', '2026-12-25'].map((d, i) => r(`a${i}`, { next_date: d }));
    rows.push(r('z', { next_date: '2026-11-30' }), r('far', { next_date: '2026-12-26' }));
    expect(annivRecent(rows, today, 30).map((x) => [x.row.id, x.days])).toEqual([
      ['a0', 1],
      ['a1', 5],
      ['z', 5],
      ['a2', 10],
      ['a3', 15],
      ['a4', 30],
    ]);
  });

  it('30 天内一个都没有：只列离今天最近的那一个（不管多远）；不算数的（已删、撤销、已归档、早于今天）不当最近的', () => {
    const rows = [
      r('later', { next_date: '2027-05-01' }),
      r('next', { next_date: '2027-02-14' }),
      r('d', { next_date: '2026-12-30', deleted_at: 1 }),
      r('u', { next_date: '2026-12-30', undone: true }),
      r('ar', { next_date: '2026-12-30', archived_at: 1 }),
      r('old', { next_date: '2026-11-24' }),
      r('n', {}),
    ];
    expect(annivRecent(rows, today, 30)).toEqual([{ row: expect.objectContaining({ id: 'next' }), days: 81 }]);
  });

  it('一个算数的纪念日都没有：空（卡里写空状态）', () => {
    expect(annivRecent([], today, 30)).toEqual([]);
    expect(annivRecent([r('d', { next_date: '2026-12-01', deleted_at: 1 }), r('old', { next_date: '2026-11-01' })], today, 30)).toEqual([]);
  });
});

describe('annivLabel、annivWhen（手机纪念日一行、电脑“最近的纪念日”卡共用）', () => {
  const words: Record<string, string> = { 'today.anniv.today': '今天', 'today.anniv.tomorrow': '明天', 'today.anniv.in': '{n} 天后', 'today.anniv.bday': '生日' };
  const t = ((k: string, p: { n?: number }) => (words[k] ?? k).replace('{n}', String(p.n))) as AnnivT;
  it('生日加“生日”，名字里已经有了不再加；纪念日、倒数日不加', () => {
    expect(annivLabel(r('a', { name: '김지민', kind: 'birthday' }), t)).toBe('김지민 生日');
    expect(annivLabel(r('b', { name: '妈妈生日', kind: 'birthday' }), t)).toBe('妈妈生日');
    expect(annivLabel(r('c', { name: '结婚纪念日', kind: 'anniversary' }), t)).toBe('结婚纪念日');
  });
  it('今天、明天、N 天后', () => {
    expect([0, 1, 3].map((d) => annivWhen(d, t))).toEqual(['今天', '明天', '3 天后']);
  });
});
