// 内置常用城市表（shared/logic/weather/cities.ts）：Open-Meteo 搜不到或排错的常用城市名（11-26 真请求：서울、首尔 0 条，부산、东京、대구 第一条是别处）
import { describe, expect, it } from 'vitest';
import { cityName, matchCities, mergePlaces } from '../../../shared/logic/weather/cities.ts';

const keys = (q: string, lang: 'zh' | 'ko') => matchCities(q, lang).map((p) => p.key);

// tests/shared 也在 Deno 下跑（ci.yml deno task test），那边的 it 没有 it.each，用循环
const FIRST: ReadonlyArray<readonly [string, 'zh' | 'ko', string]> = [
    ['서울', 'ko', 'seoul'],
    ['부산', 'ko', 'busan'],
    ['대구', 'ko', 'daegu'],
    ['首尔', 'zh', 'seoul'],
    ['东京', 'zh', 'tokyo'],
    ['上海', 'zh', 'shanghai'],
    ['Seoul', 'ko', 'seoul'],
    ['seoul', 'zh', 'seoul'],
    ['서울시', 'ko', 'seoul'],
    ['서울특별시', 'ko', 'seoul'],
    ['上海市', 'zh', 'shanghai'],
    ['首尔特别市', 'zh', 'seoul'],
    ['도쿄', 'ko', 'tokyo'],
];

describe('matchCities', () => {
  for (const [q, lang, key] of FIRST) {
    it(`${q}（${lang}）第一条是 ${key}`, () => {
      expect(keys(q, lang)[0]).toBe(key);
    });
  }

  it('名字和国家按界面语言回，坐标是粗坐标', () => {
    expect(matchCities('首尔', 'zh')).toEqual([{ key: 'seoul', name: '首尔', sub: '韩国', lat: 37.6, lon: 127 }]);
    expect(matchCities('首尔', 'ko')).toEqual([{ key: 'seoul', name: '서울', sub: '대한민국', lat: 37.6, lon: 127 }]);
  });

  it('打一个字就按开头列出来；不沾边的、空的不出', () => {
    expect(keys('대', 'ko')).toEqual(['daegu', 'daejeon']);
    expect(keys('강진', 'ko')).toEqual([]);
    expect(keys('  ', 'ko')).toEqual([]);
  });
});

describe('cityName', () => {
  it('内置城市跟着语言变；别的用存下的名字', () => {
    expect(cityName({ key: 'busan', name: '부산' }, 'zh')).toBe('釜山');
    expect(cityName({ key: 'busan', name: '부산' }, 'ko')).toBe('부산');
    expect(cityName({ name: '강진군' }, 'zh')).toBe('강진군');
    expect(cityName({ key: 'nope', name: 'X' }, 'zh')).toBe('X');
  });
});

describe('mergePlaces', () => {
  it('内置的在前；Open-Meteo 里离内置城市不到 0.3° 的去掉；最多 limit 条', () => {
    const own = [{ key: 'busan', name: '부산', sub: '대한민국', lat: 35.1, lon: 129 }];
    const up = [
      { name: '부산광역시', sub: '', lat: 35.2, lon: 129.1 },
      { name: '부산', sub: '충청북도', lat: 36.6, lon: 127.5 },
      { name: 'A', sub: '', lat: 1, lon: 1 },
    ];
    expect(mergePlaces(own, up, 2).map((p) => p.name)).toEqual(['부산', '부산']);
    expect(mergePlaces(own, up, 8)).toHaveLength(3);
  });
});
