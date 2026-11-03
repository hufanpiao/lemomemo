// shared/logic/calendar/holidays.ts（TC-B2-12；架构 5.12 第 1 点、R-97、第 9 节单元 holidays）
// 用的是测试自造的节假日数据，不是官方公布的日程
import { describe, expect, it } from 'vitest';
import {
  holidayCountries,
  holidayFetchPaths,
  holidayMarks,
  holidayYears,
  parseHolidayFile,
  type HolidayFile,
} from '../../../shared/logic/calendar/holidays.ts';

describe('holidayCountries：三种设置 × 两种界面语言', () => {
  it('设置过：按设置，不跟界面语言', () => {
    expect(holidayCountries('cn', 'zh-CN')).toEqual(['cn']);
    expect(holidayCountries('cn', 'ko-KR')).toEqual(['cn']);
    expect(holidayCountries('kr', 'zh-CN')).toEqual(['kr']);
    expect(holidayCountries('kr', 'ko-KR')).toEqual(['kr']);
  });

  it('两国都显示：和界面语言同一国的排在前面', () => {
    expect(holidayCountries('both', 'zh-CN')).toEqual(['cn', 'kr']);
    expect(holidayCountries('both', 'ko-KR')).toEqual(['kr', 'cn']);
  });

  it('没设置过：跟界面语言，切语言就跟着变', () => {
    expect(holidayCountries(undefined, 'zh-CN')).toEqual(['cn']);
    expect(holidayCountries(undefined, 'ko-KR')).toEqual(['kr']);
    expect(holidayCountries(null, 'ko-KR')).toEqual(['kr']);
  });

  it('不认识的值当没设置', () => {
    expect(holidayCountries('jp', 'ko-KR')).toEqual(['kr']);
    expect(holidayCountries({ v: 'cn' }, 'ko-KR')).toEqual(['kr']);
  });
});

describe('要拉哪些文件（只拉需要的国家）', () => {
  it('年份：11、12 月带明年，1 月带去年，其余只要当年', () => {
    expect(holidayYears(2026, 10)).toEqual([2026]);
    expect(holidayYears(2026, 11)).toEqual([2026, 2027]);
    expect(holidayYears(2026, 12)).toEqual([2026, 2027]);
    expect(holidayYears(2027, 1)).toEqual([2027, 2026]);
  });
  it('路径：只含选中的国家', () => {
    expect(holidayFetchPaths(['kr'], [2026, 2027])).toEqual(['holidays/kr/2026.json', 'holidays/kr/2027.json']);
    expect(holidayFetchPaths(['cn', 'kr'], [2027])).toEqual(['holidays/cn/2027.json', 'holidays/kr/2027.json']);
  });
});

const cnRaw = {
  country: 'cn',
  year: 2027,
  days: [
    { date: '2027-02-06', kind: 'off', name: { zh: '春节', ko: '춘절' } },
    { date: '2027-02-07', kind: 'off', name: { zh: '春节' } },
    { date: '2027-02-14', kind: 'work', name: { zh: '补班', ko: '대체 근무' } },
    { date: '2027-10-01', kind: 'off', name: { zh: '国庆节', ko: '국경절' } },
  ],
};
const krRaw = {
  country: 'kr',
  year: 2027,
  days: [
    { date: '2027-02-06', kind: 'off', name: { ko: '설날', zh: '春节（韩国）' } },
    { date: '2027-10-03', kind: 'off', name: { ko: '개천절' } },
  ],
};

describe('parseHolidayFile：校验拉回来的 JSON', () => {
  it('形状对就收下', () => {
    const f = parseHolidayFile(cnRaw, 'cn', 2027);
    expect(f?.days).toHaveLength(4);
  });

  it('整份 [] 或 days 为空数组：这一年没有节假日，不当坏数据', () => {
    expect(parseHolidayFile([], 'kr', 2027)).toEqual({ country: 'kr', year: 2027, days: [] });
    expect(parseHolidayFile({ country: 'cn', year: 2027, days: [] }, 'cn', 2027)).toEqual({ country: 'cn', year: 2027, days: [] });
    expect(parseHolidayFile([1], 'kr', 2027)).toBeNull();
  });

  it('国家、年份和请求的文件对不上 → null', () => {
    expect(parseHolidayFile(cnRaw, 'kr', 2027)).toBeNull();
    expect(parseHolidayFile(cnRaw, 'cn', 2026)).toBeNull();
  });

  it('任何一天不对整份不用：日期不在这一年、日期不存在、没有名字、韩国出现补班', () => {
    const bad = (day: unknown, country: 'cn' | 'kr' = 'cn') => parseHolidayFile({ country, year: 2027, days: [day] }, country, 2027);
    expect(bad({ date: '2026-12-31', kind: 'off', name: { zh: '元旦' } })).toBeNull();
    expect(bad({ date: '2027-02-30', kind: 'off', name: { zh: '元旦' } })).toBeNull();
    expect(bad({ date: '2027-01-01', kind: 'off', name: {} })).toBeNull();
    expect(bad({ date: '2027-01-01', kind: 'off', name: { zh: '' } })).toBeNull();
    expect(bad({ date: '2027-01-01', kind: 'holiday', name: { zh: '元旦' } })).toBeNull();
    expect(bad({ date: '2027-02-13', kind: 'work', name: { ko: '근무' } }, 'kr')).toBeNull();
    expect(parseHolidayFile(null, 'cn', 2027)).toBeNull();
    expect(parseHolidayFile({ country: 'cn', year: 2027 }, 'cn', 2027)).toBeNull();
  });
});

describe('holidayMarks：合成“日期 → 当天的节假日”', () => {
  const cn = parseHolidayFile(cnRaw, 'cn', 2027) as HolidayFile;
  const kr = parseHolidayFile(krRaw, 'kr', 2027) as HolidayFile;

  it('两国都显示、同一天都有：中文界面中国在前，韩文界面韩国在前；名字按界面语言', () => {
    const zh = holidayMarks([cn, kr], holidayCountries('both', 'zh-CN'), 'zh-CN');
    expect(zh.get('2027-02-06')).toEqual([
      { country: 'cn', kind: 'off', name: '春节' },
      { country: 'kr', kind: 'off', name: '春节（韩国）' },
    ]);
    const ko = holidayMarks([cn, kr], holidayCountries('both', 'ko-KR'), 'ko-KR');
    expect(ko.get('2027-02-06')).toEqual([
      { country: 'kr', kind: 'off', name: '설날' },
      { country: 'cn', kind: 'off', name: '춘절' },
    ]);
  });

  it('界面语言那份名字缺了用本国语言', () => {
    const ko = holidayMarks([cn, kr], ['kr', 'cn'], 'ko-KR');
    expect(ko.get('2027-02-07')).toEqual([{ country: 'cn', kind: 'off', name: '春节' }]);
    const zh = holidayMarks([cn, kr], ['cn', 'kr'], 'zh-CN');
    expect(zh.get('2027-10-03')).toEqual([{ country: 'kr', kind: 'off', name: '개천절' }]);
  });

  it('补班只在包含中国时出现（只看韩国时内存里的中国文件不用）', () => {
    expect(holidayMarks([cn, kr], ['cn'], 'zh-CN').get('2027-02-14')).toEqual([{ country: 'cn', kind: 'work', name: '补班' }]);
    expect(holidayMarks([cn, kr], ['kr', 'cn'], 'ko-KR').get('2027-02-14')).toEqual([{ country: 'cn', kind: 'work', name: '대체 근무' }]);
    const krOnly = holidayMarks([cn, kr], ['kr'], 'ko-KR');
    expect(krOnly.get('2027-02-14')).toBe(undefined);
    expect(krOnly.get('2027-10-01')).toBe(undefined);
    expect(krOnly.get('2027-10-03')).toEqual([{ country: 'kr', kind: 'off', name: '개천절' }]);
  });

  it('同一份文件传两次不重复', () => {
    expect(holidayMarks([cn, cn], ['cn'], 'zh-CN').get('2027-10-01')).toHaveLength(1);
  });

  it('同一国同一天放假在前、补班在后', () => {
    const mixed = parseHolidayFile(
      {
        country: 'cn',
        year: 2027,
        days: [
          { date: '2027-05-01', kind: 'work', name: { zh: '补班' } },
          { date: '2027-05-01', kind: 'off', name: { zh: '劳动节' } },
        ],
      },
      'cn',
      2027,
    ) as HolidayFile;
    expect(holidayMarks([mixed], ['cn'], 'zh-CN').get('2027-05-01')?.map((m) => m.kind)).toEqual(['off', 'work']);
  });
});
