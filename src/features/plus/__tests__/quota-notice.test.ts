// 额度恢复时刻（shared/logic/ai-quota.ts，前端显示这一侧再钉一遍）、每天一次的提示、提示条文案选择（data/quota.ts、data/notice.ts；R-163、R-166、R-187、R-200）
import { describe, expect, it } from 'vitest';
import { noticeLines, type NoticeInput } from '../data/notice.ts';
import type { Draft } from '../../../core/cache.ts';
import { quotaResetAt, quotaResetClock } from '../../../../shared/logic/ai-quota.ts';
import { markQuotaNotice, QUOTA_DRAFT_ID, quotaNoticeDue, quotaOutToday, rememberQuotaLeft } from '../data/quota.ts';

function memStore(): Pick<Storage, 'getItem' | 'setItem'> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

describe('恢复时刻：下一个太平洋午夜换成 current_tz（R-187）', () => {
  it('冬令时：首尔 17:00', () => {
    const now = Date.UTC(2026, 11, 1, 3, 0); // 12-01 12:00 首尔
    expect(quotaResetClock(now, 'Asia/Seoul')).toBe('17:00');
    expect(quotaResetAt(now)).toBe(Date.UTC(2026, 11, 1, 8, 0));
  });
  it('夏令时：首尔 16:00', () => {
    expect(quotaResetClock(Date.UTC(2026, 6, 1, 3, 0), 'Asia/Seoul')).toBe('16:00');
  });
  it('洛杉矶本地：00:00', () => {
    expect(quotaResetClock(Date.UTC(2026, 6, 1, 3, 0), 'America/Los_Angeles')).toBe('00:00');
  });
});

describe('“用完了”的提示每天只出一次（按太平洋日期）', () => {
  it('出过以后当天不再出，过了太平洋午夜又出', () => {
    const s = memStore();
    const now = Date.UTC(2026, 11, 1, 3, 0);
    expect(quotaNoticeDue(now, s)).toBe(true);
    markQuotaNotice(now, s);
    expect(quotaNoticeDue(now + 4 * 3600_000, s)).toBe(false);
    expect(quotaNoticeDue(Date.UTC(2026, 11, 1, 8, 0), s)).toBe(true);
  });
  it('本机记着的剩余次数：存本机库 drafts 仓（按账号分），今天用完才算，换一天作废，库不可用当没用完', async () => {
    const m = new Map<string, Draft>();
    const c = { getDraft: async (id: string) => m.get(id), putDraft: async (d: Draft) => void m.set(d.id, d) };
    const now = Date.UTC(2026, 11, 1, 3, 0);
    await rememberQuotaLeft(3, now, c);
    expect(await quotaOutToday(now, c)).toBe(false);
    await rememberQuotaLeft(0, now, c);
    expect(m.get(QUOTA_DRAFT_ID)).toMatchObject({ kind: 'quota', data: { left: 0 } });
    expect(await quotaOutToday(now, c)).toBe(true);
    expect(await quotaOutToday(Date.UTC(2026, 11, 2, 9, 0), c)).toBe(false);
    expect(await quotaOutToday(now, null)).toBe(false);
    const bad = { getDraft: async () => Promise.reject(new Error('closed')), putDraft: async () => Promise.reject(new Error('closed')) };
    await expect(rememberQuotaLeft(0, now, bad)).resolves.toBeUndefined();
    expect(await quotaOutToday(now, bad)).toBe(false);
  });
});

const base = (over: Partial<NoticeInput> = {}): NoticeInput => ({
  status: 'saved', titles: ['call'], hints: { recur: false, arrange: false, bad_day: null }, remind: false, quotaNoticeDue: true, resetClock: '17:00', ...over,
});

describe('noticeLines', () => {
  it('一条 / 多条', () => {
    expect(noticeLines(base())).toEqual([{ key: 'plus.notice.saved', params: { title: 'call' } }]);
    expect(noticeLines(base({ titles: ['a', 'b', 'c'] }))[0]).toEqual({ key: 'plus.notice.savedN', params: { n: 3 } });
  });
  it('AI 没回应：已先记下', () => {
    expect(noticeLines(base({ status: 'saved_rule' }))[0]?.key).toBe('plus.notice.savedRule');
  });
  it('额度用完：带恢复时刻；当天出过就退成普通“已记下”', () => {
    expect(noticeLines(base({ status: 'quota_out' }))[0]).toEqual({ key: 'plus.notice.quota', params: { time: '17:00' } });
    expect(noticeLines(base({ status: 'quota_out', quotaNoticeDue: false }))[0]?.key).toBe('plus.notice.saved');
  });
  it('离线：带提醒的再加一句', () => {
    expect(noticeLines(base({ status: 'offline_saved', remind: true })).map((l) => l.key)).toEqual(['plus.notice.offline', 'plus.notice.offlineRemind']);
    expect(noticeLines(base({ status: 'offline_saved' })).map((l) => l.key)).toEqual(['plus.notice.offline']);
  });
  it('附加句：重复（R-163）、自己排时间（R-200）、没有的日子（R-166）', () => {
    const lines = noticeLines(base({ hints: { recur: true, arrange: true, bad_day: { month: 11, day: 31 } } }));
    expect(lines.slice(1)).toEqual([
      { key: 'plus.notice.recur', params: {} },
      { key: 'plus.notice.arrange', params: {} },
      { key: 'plus.notice.badDay', params: { month: 11, day: 31 } },
    ]);
  });
});
