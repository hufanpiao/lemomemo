// 今天页顶部的纪念日一行（B5 S14）：7 天内最近的一个，用服务器的 next_date
import { describe, expect, it } from 'vitest';
import { ANNIV_SOON_DAYS, annivLabel, annivUpcoming, annivWhen, type AnnivT } from '../data/anniv-soon.ts';

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

describe('annivLabel、annivWhen（手机纪念日一行、电脑“快到了”块共用）', () => {
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
