// 补班尾巴和节假日数据一致（R-338、R-340、R-106 B2K-06）：ui/holiday-tail-data.ts 的 CN_WORKDAY_TAILS 是数据常量，
// src/public/holidays/cn/*.json 里每个补班日的中文名以“补班”结尾、韩文名以“ 대체 근무일”结尾；审校改了写法时这条会提醒同步改常量。
// 韩文名按 R-340 由后端改数据（“원단 대체근무”→“신정 대체 근무일”）：数据还没改过来时韩文两条先跳过，改过来以后自动生效
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DateStr } from '../../../../shared/core/date.ts';
import { holidayMarks, parseHolidayFile } from '../../../../shared/logic/calendar/holidays.ts';
import { CN_WORKDAY_TAILS } from '../ui/holiday-tail-data.ts';
import { holText } from '../ui/cal-ui.ts';

const DIR = join(import.meta.dirname, '../../../public/holidays/cn');
type Day = { date?: string; kind?: string; name?: { zh?: string; ko?: string } };
const files = readdirSync(DIR).filter((f) => /^\d{4}\.json$/.test(f));
const workdays = files.flatMap((f) => ((JSON.parse(readFileSync(join(DIR, f), 'utf8')) as { days?: Day[] }).days ?? [])
  .filter((d) => d.kind === 'work').map((d) => ({ f, d })));
const koMigrated = workdays.some(({ d }) => d.name?.ko?.endsWith(CN_WORKDAY_TAILS.ko) === true);

describe('补班尾巴（数据常量）和中国节假日文件一致', () => {
  it('每个补班日的中文名以“补班”结尾', () => {
    expect(workdays.length).toBeGreaterThan(0);
    for (const { f, d } of workdays) if (d.name?.zh !== undefined) expect(d.name.zh.endsWith(CN_WORKDAY_TAILS.zh), `${f} ${d.name.zh}`).toBe(true);
  });
  it.skipIf(!koMigrated)('每个补班日的韩文名（有的话）以“ 대체 근무일”结尾（R-340）', () => {
    for (const { f, d } of workdays) if (d.name?.ko !== undefined) expect(d.name.ko.endsWith(CN_WORKDAY_TAILS.ko), `${f} ${d.name.ko}`).toBe(true);
  });
  const first = workdays.find(({ f }) => f === '2026.json')?.d;
  const file = parseHolidayFile(JSON.parse(readFileSync(join(DIR, '2026.json'), 'utf8')) as unknown, 'cn', 2026);
  it('中文界面：holidayMarks 取中文名，月格去掉“补班”', () => {
    if (!file || !first?.date) throw new Error('2026.json 没有补班日');
    const m = holidayMarks([file], ['cn'], 'zh-CN').get(first.date as DateStr)?.find((h) => h.kind === 'work');
    if (!m) throw new Error('中文没有补班');
    expect(holText(m, '班')).toBe(`班·${(first.name?.zh ?? '').slice(0, -CN_WORKDAY_TAILS.zh.length)}`);
  });
  it.skipIf(!koMigrated)('韩文界面：holidayMarks 取韩文名，月格写“근무·<名>”，不再出现两遍“근무”', () => {
    if (!file || !first?.date) throw new Error('2026.json 没有补班日');
    const m = holidayMarks([file], ['cn'], 'ko-KR').get(first.date as DateStr)?.find((h) => h.kind === 'work');
    if (!m) throw new Error('韩文没有补班');
    expect(m.name.endsWith(CN_WORKDAY_TAILS.ko)).toBe(true);
    expect(holText(m, '근무')).toBe(`근무·${m.name.slice(0, -CN_WORKDAY_TAILS.ko.length).trim()}`);
  });
});
