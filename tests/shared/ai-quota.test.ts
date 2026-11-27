// shared/logic/ai-quota.ts：恢复时刻和计数日，和服务器（_shared/ai/gate.ts）同一口径
import { describe, expect, it } from 'vitest';
import { quotaDay, quotaResetAt, quotaResetClock, quotaResetsToday } from '../../shared/logic/ai-quota.ts';
import { nextPacificMidnight, pacificDate } from '../../supabase/functions/_shared/ai/gate.ts';

describe('恢复时刻：下一个太平洋午夜换成 current_tz（R-187）', () => {
  it('冬令时：首尔 17:00', () => {
    const now = Date.UTC(2026, 11, 1, 3, 0); // 12-01 12:00 首尔
    expect(quotaResetClock(now, 'Asia/Seoul')).toBe('17:00');
    expect(quotaResetAt(now)).toBe(Date.UTC(2026, 11, 1, 8, 0));
  });
  it('夏令时：首尔 16:00', () => {
    expect(quotaResetClock(Date.UTC(2026, 6, 1, 3, 0), 'Asia/Seoul')).toBe('16:00');
  });
  it('恢复是今天还是明天（按住说话挡住时的提示）：首尔上午用完今天 17:00 恢复，17:00 以后用完明天；洛杉矶永远是明天 00:00', () => {
    expect(quotaResetsToday(Date.UTC(2026, 11, 1, 3, 0), 'Asia/Seoul'), '12-01 12:00 首尔').toBe(true);
    expect(quotaResetsToday(Date.UTC(2026, 11, 1, 9, 0), 'Asia/Seoul'), '12-01 18:00 首尔').toBe(false);
    expect(quotaResetsToday(Date.UTC(2026, 11, 1, 20, 0), 'America/Los_Angeles')).toBe(false);
  });
  it('洛杉矶本地：00:00', () => {
    expect(quotaResetClock(Date.UTC(2026, 6, 1, 3, 0), 'America/Los_Angeles')).toBe('00:00');
  });
  it('和服务器同一口径：夏令时切换前后几天逐小时比 quotaDay = pacificDate、quotaResetAt = nextPacificMidnight', () => {
    for (const start of [Date.UTC(2026, 2, 6), Date.UTC(2026, 9, 30), Date.UTC(2026, 11, 30)]) {
      for (let h = 0; h < 24 * 4; h += 1) {
        const t = start + h * 3_600_000 + 17 * 60_000;
        expect(quotaDay(t), new Date(t).toISOString()).toBe(pacificDate(t));
        expect(quotaResetAt(t), new Date(t).toISOString()).toBe(nextPacificMidnight(t));
      }
    }
  });
});
