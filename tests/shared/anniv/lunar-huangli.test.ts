// shared/logic/anniv/lunar-huangli.ts 的单测（R-431 黄历卡）。
// 宜忌期望值由开发依赖 lunar-javascript 1.7.7 给出（2026-11-15 的“忌 嫁娶 安葬”另和主流黄历网站核对过）；
// 1901～2100 全量逐日对拍在 npm run check:huangli（tools/huangli/build.mjs --check）。
// 纯日期运算，和进程时区无关：npm run test:tz 在 UTC、首尔、洛杉矶各跑一遍；Deno（tests/shared）也跑。
import { describe, expect, it } from 'vitest';
import { dayJiazi, ganzhiName, huangliOf, monthZhi, yiJiOf } from '../../../shared/logic/anniv/lunar-huangli.ts';

describe('lunar-huangli', () => {
  it('2026-11-15：初七、丙午年十月；破日的宜忌', () => {
    expect(huangliOf('2026-11-15')).toEqual({
      day: '初七',
      yearGz: '丙午',
      month: '十月',
      yi: ['破屋', '坏垣', '求医', '治病', '余事勿取'],
      ji: ['嫁娶', '安葬'],
    });
  });

  it('日干支：1970-01-01 辛巳、2026-11-15 癸巳；名字按序号', () => {
    expect(ganzhiName(dayJiazi('1970-01-01'))).toBe('辛巳');
    expect(ganzhiName(dayJiazi('2026-11-15'))).toBe('癸巳');
    expect(ganzhiName(dayJiazi('1969-12-31'))).toBe('庚辰');
    expect(ganzhiName(0)).toBe('甲子');
    expect(ganzhiName(59)).toBe('癸亥');
  });

  it('节气月按香港天文台交节日划，交节当天算新月（2026 立冬 11-07：前一天戌月、当天亥月）', () => {
    expect(monthZhi('2026-11-06')).toBe(10);
    expect(monthZhi('2026-11-07')).toBe(11);
    expect(yiJiOf('2026-11-07')).toEqual({ yi: ['解除', '余事勿取'], ji: [] });
    expect(yiJiOf('2026-11-06')?.ji).toEqual(['开市', '开仓', '出货财', '安床', '安门', '安葬']);
  });

  it('小寒以前是子月，小寒当天丑月、立春当天寅月（2026：小寒 01-05、立春 02-04）', () => {
    expect(monthZhi('2026-01-01')).toBe(0);
    expect(monthZhi('2026-01-04')).toBe(0);
    expect(monthZhi('2026-01-05')).toBe(1);
    expect(monthZhi('2026-02-03')).toBe(1);
    expect(monthZhi('2026-02-04')).toBe(2);
  });

  it('干支年按正月初一换年：2026-02-16 腊月廿九乙巳，02-17 正月初一丙午', () => {
    expect(huangliOf('2026-02-16')).toMatchObject({ day: '廿九', yearGz: '乙巳', month: '腊月' });
    expect(huangliOf('2026-02-17')).toMatchObject({ day: '初一', yearGz: '丙午', month: '正月' });
  });

  it('闰月写“闰六月”（2025-07-25 闰六月初一）', () => {
    expect(huangliOf('2025-07-25')).toMatchObject({ day: '初一', yearGz: '乙巳', month: '闰六月' });
  });

  it('宜项很多的一天全给（2020-05-15 宜 20 项）；库写“无”的一边是空数组', () => {
    const h = huangliOf('2020-05-15');
    expect(h?.yi).toHaveLength(20);
    expect(h?.yi.slice(0, 3)).toEqual(['开光', '出行', '纳采']);
    expect(h?.ji).toEqual([]);
  });

  it('“诸事不宜”照原文；“馀事勿取”写成“余事勿取”', () => {
    expect(yiJiOf('2020-04-14')).toEqual({ yi: ['诸事不宜'], ji: [] });
    const all = ['2026-11-15', '2026-11-07', '2026-02-17'].flatMap((d) => yiJiOf(d)?.yi ?? []);
    expect(all).toContain('余事勿取');
    expect(all.join('')).not.toContain('馀');
  });

  it('超出数据范围回 null：1901-01-19 以前、2101 年以后', () => {
    expect(huangliOf('1901-01-19')).toBeNull();
    expect(huangliOf('1901-01-20')).toMatchObject({ day: '初一', yearGz: '庚子', month: '腊月' });
    expect(huangliOf('2100-12-31')).toMatchObject({ day: '初一', month: '腊月' });
    expect(huangliOf('2101-01-01')).toBeNull();
    expect(monthZhi('2101-06-01')).toBeNull();
  });

  it('格式不对抛 bad_date（同 toLunar）', () => {
    expect(() => huangliOf('2026-13-01')).toThrow();
  });
});
