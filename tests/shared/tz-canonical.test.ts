// shared/i18n/tz-label.ts 的 canonicalTz：时区名校验加规范化（接手清单 KO-mail-tz-low L1）。
// 期望按 Node 24 实测写；11-05 在 Deno 2.9.8 跑同一组输入，逐条一致（见 tz-label.ts 的说明）。
import { describe, expect, it } from 'vitest';
import { canonicalTz, fixedTzLabel, LABEL_REF_MS, tzLabel } from '../../shared/i18n/tz-label.ts';

describe('canonicalTz：Intl 认得就回规范名，不认得回 null', () => {
  it('大小写变体归一到规范名', () => {
    expect(canonicalTz('Asia/Seoul')).toBe('Asia/Seoul');
    expect(canonicalTz('asia/seoul')).toBe('Asia/Seoul');
    expect(canonicalTz('ASIA/SEOUL')).toBe('Asia/Seoul');
    expect(canonicalTz('america/new_york')).toBe('America/New_York');
    expect(canonicalTz('utc')).toBe('UTC');
  });

  it('别名按 Intl 的规范名走（不一定是 IANA 现行名）', () => {
    expect(canonicalTz('ROK')).toBe('Asia/Seoul');
    expect(canonicalTz('PRC')).toBe('Asia/Shanghai');
    expect(canonicalTz('Asia/Chongqing')).toBe('Asia/Shanghai');
    expect(canonicalTz('Japan')).toBe('Asia/Tokyo');
    expect(canonicalTz('US/Eastern')).toBe('America/New_York');
    // V8 的 ICU 把 Kolkata 归到旧名 Calcutta；WebKit 别名原样返回。两种写法同一个时刻、同一个说法即可
    const kol = canonicalTz('Asia/Kolkata');
    expect(['Asia/Calcutta', 'Asia/Kolkata']).toContain(kol);
    expect(canonicalTz('Asia/Calcutta')).toBe(kol);
    expect(canonicalTz('asia/calcutta')).toBe(kol);
  });

  it('非法值、空串、过长、非字符串回 null', () => {
    expect(canonicalTz('Not/AZone')).toBeNull();
    expect(canonicalTz('')).toBeNull();
    expect(canonicalTz(' ')).toBeNull();
    expect(canonicalTz('Asia/Seoul ')).toBeNull();
    expect(canonicalTz(`Asia/${'x'.repeat(64)}`)).toBeNull();
    expect(canonicalTz(null)).toBeNull();
    expect(canonicalTz(undefined)).toBeNull();
    expect(canonicalTz(9)).toBeNull();
  });
});

describe('tzLabel 先过 canonicalTz：大小写变体、别名对上固定表（不再落到 Intl 的“표준시 / 标准时间”）', () => {
  // 不用 it.each：Deno 跑 tests/shared 用的 vitest 替身（deno-vitest-shim.ts）没有它
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['asia/seoul', '韩国时间', '한국 시간'],
    ['ROK', '韩国时间', '한국 시간'],
    ['PRC', '北京时间', '중국 시간'],
    ['japan', '日本时间', '일본 시간'],
    ['US/Eastern', '美国东部时间', '미국 동부 시간'],
  ];
  for (const [zone, zh, ko] of cases) {
    it(zone, () => {
      expect(tzLabel(zone, 'zh-CN')).toBe(zh);
      expect(tzLabel(zone, 'ko-KR')).toBe(ko);
    });
  }

  it('Kolkata 和 Calcutta 两种写法说法相同', () => {
    for (const loc of ['zh-CN', 'ko-KR'] as const) {
      expect(tzLabel('Asia/Kolkata', loc)).toBe(tzLabel('Asia/Calcutta', loc));
    }
  });

  it('认不得的原样回（调用方本应先校验）', () => {
    expect(tzLabel('Not/AZone', 'zh-CN')).toBe('Not/AZone');
  });
});

describe('固定表不依赖规范化（canonicalTz 复审 T2）', () => {
  // WebKit 只统一大小写、别名原样返回（11-05 实测 Playwright WebKit 27.2），所以别名本身就要在固定表里
  it('不经 canonicalTz，常见别名直接就能对上固定表', () => {
    const same: ReadonlyArray<readonly [string, string]> = [
      ['ROK', 'Asia/Seoul'],
      ['PRC', 'Asia/Shanghai'], ['Asia/Chongqing', 'Asia/Shanghai'], ['Asia/Chungking', 'Asia/Shanghai'], ['Asia/Harbin', 'Asia/Shanghai'],
      ['Japan', 'Asia/Tokyo'],
      ['Hongkong', 'Asia/Hong_Kong'],
      ['ROC', 'Asia/Taipei'],
      ['Singapore', 'Asia/Singapore'],
      ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
      ['US/Eastern', 'America/New_York'], ['US/Central', 'America/Chicago'], ['US/Mountain', 'America/Denver'],
      ['US/Pacific', 'America/Los_Angeles'], ['US/Hawaii', 'Pacific/Honolulu'],
      ['Navajo', 'America/Denver'], ['America/Shiprock', 'America/Denver'], ['US/Pacific-New', 'America/Los_Angeles'], ['Pacific/Johnston', 'Pacific/Honolulu'],
      ['GB', 'Europe/London'], ['Europe/Belfast', 'Europe/London'],
      ['Australia/NSW', 'Australia/Sydney'], ['Australia/ACT', 'Australia/Sydney'], ['Australia/Canberra', 'Australia/Sydney'],
    ];
    for (const [alias, zone] of same) {
      for (const loc of ['zh-CN', 'ko-KR'] as const) {
        expect(fixedTzLabel(alias, loc), `${alias} ${loc}`).not.toBeNull();
        expect(fixedTzLabel(alias, loc), `${alias} ${loc}`).toBe(fixedTzLabel(zone, loc));
      }
    }
  });

  it('固定表里的每个现行名，经本运行环境规范化以后仍在表里（V8 把 Asia/Ho_Chi_Minh 归成 Asia/Saigon）', () => {
    const zones = ['Asia/Seoul', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Singapore', 'Asia/Bangkok',
      'Asia/Ho_Chi_Minh', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Pacific/Honolulu',
      'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Australia/Sydney'];
    for (const zone of zones) {
      const c = canonicalTz(zone) ?? '';
      expect(c, zone).not.toBe('');
      for (const loc of ['zh-CN', 'ko-KR'] as const) {
        expect(fixedTzLabel(c, loc), `${zone} → ${c} ${loc}`).toBe(fixedTzLabel(zone, loc));
        expect(tzLabel(zone, loc), `${zone} ${loc}`).toBe(fixedTzLabel(zone, loc));
      }
    }
  });
});

describe('表外时区按现在的归属说（代码审查第七节 M1）', () => {
  // 原来按 1970 年取：基辅等地说成“莫斯科标准时间”，加沙、希伯伦说成“以色列标准时间”，廷布说成“印度时间”
  const zones = ['Europe/Kyiv', 'Europe/Kiev', 'Europe/Riga', 'Europe/Tallinn', 'Europe/Vilnius', 'Europe/Chisinau', 'Asia/Gaza', 'Asia/Hebron'];
  const wrong = /莫斯科|모스크바|以色列|이스라엘/;

  it('基辅、波罗的海三国、基希讷乌、加沙、希伯伦：中韩说法里没有“莫斯科 / 以色列”', () => {
    for (const zone of zones) {
      for (const loc of ['zh-CN', 'ko-KR'] as const) {
        expect(tzLabel(zone, loc), `${zone} ${loc}`).not.toMatch(wrong);
      }
    }
    expect(tzLabel('Asia/Thimphu', 'zh-CN')).not.toMatch(/印度/);
    expect(tzLabel('Asia/Thimphu', 'ko-KR')).not.toMatch(/인도/);
  });

  it('对照：显式按 1970 年取，确实会说成莫斯科、以色列（at 参数在起作用；运行环境不认 longGeneric 时退回 IANA 名，不比）', () => {
    const kyiv = tzLabel('Europe/Kyiv', 'zh-CN', 0);
    const gaza = tzLabel('Asia/Gaza', 'zh-CN', 0);
    if (kyiv !== 'Europe/Kyiv') expect(kyiv).toMatch(/莫斯科/);
    if (gaza !== 'Asia/Gaza') expect(gaza).toMatch(/以色列/);
    expect(tzLabel('Europe/Kyiv', 'zh-CN')).not.toBe(kyiv);
  });

  it('不传 at 时按参照时刻取，和显式传参照时刻一样（结果不随跑测试的日子变）', () => {
    for (const zone of [...zones, 'Asia/Thimphu', 'Europe/Amsterdam', 'Asia/Beirut']) {
      for (const loc of ['zh-CN', 'ko-KR'] as const) {
        expect(tzLabel(zone, loc), `${zone} ${loc}`).toBe(tzLabel(zone, loc, LABEL_REF_MS));
      }
    }
  });
});
