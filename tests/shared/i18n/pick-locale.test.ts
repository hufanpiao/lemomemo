// shared/i18n/pick-locale 的单元测试（架构 16.4）。纯函数，三个时区和 Deno 下结果都一样。
import { describe, expect, it } from 'vitest';
import {
  asLocale,
  fromUiLocale,
  localeFromCookieHeader,
  parseAcceptLanguage,
  pickLocale,
  toUiLocale,
} from '../../../shared/i18n/pick-locale.ts';

describe('pickLocale', () => {
  it('手动选过的优先', () => {
    expect(pickLocale('zh', ['ko-KR'])).toBe('zh');
    expect(pickLocale('ko', ['zh-CN'])).toBe('ko');
  });

  it('saved 不是 zh / ko 时当没选过', () => {
    expect(pickLocale('en', ['ko-KR'])).toBe('ko');
    expect(pickLocale('', ['ko'])).toBe('ko');
    expect(pickLocale(null, ['ko'])).toBe('ko');
    expect(pickLocale(undefined, [])).toBe('zh');
  });

  it('按设备语言从前往后找第一个 ko 或 zh', () => {
    expect(pickLocale(null, ['en-US', 'ko'])).toBe('ko');
    expect(pickLocale(null, ['en-US', 'zh-TW', 'ko'])).toBe('zh');
    expect(pickLocale(null, ['KO-kr'])).toBe('ko');
    expect(pickLocale(null, ['zh-Hans-CN'])).toBe('zh');
  });

  it('只认语言主标签：kok、zhx 不算', () => {
    expect(pickLocale(null, ['kok-IN', 'zhx', 'ko'])).toBe('ko');
    expect(pickLocale(null, ['kok'])).toBe('zh');
  });

  it('都没有默认中文', () => {
    expect(pickLocale(null, ['en-US', 'ja'])).toBe('zh');
  });

  // 16.4 第 9 条的前一半：登录前（清空存储），浏览器语言 ko-KR → 韩文（App 页面那一半在 B1）
  it('16.4 第 9 条（登录前）：navigator.languages 是 ko-KR、没有 pv-locale 和 cookie → ko', () => {
    expect(pickLocale(null, ['ko-KR', 'ko'])).toBe('ko');
  });
});

describe('parseAcceptLanguage', () => {
  it('按 q 降序，同 q 保持原顺序', () => {
    expect(parseAcceptLanguage('en-US,ko;q=0.5')).toEqual(['en-US', 'ko']);
    expect(parseAcceptLanguage('ko;q=0.5, zh;q=0.9, en')).toEqual(['en', 'zh', 'ko']);
    expect(parseAcceptLanguage('ko-KR,ko;q=0.9,en-US;q=0.8')).toEqual(['ko-KR', 'ko', 'en-US']);
  });

  it('去掉 q=0、* 和坏格式', () => {
    expect(parseAcceptLanguage('ko;q=0, *, zh;q=abc, en')).toEqual(['en']);
    expect(parseAcceptLanguage('')).toEqual([]);
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage(' , ;q=1')).toEqual([]);
  });
});

describe('cookie', () => {
  it('取 lemo_lang', () => {
    expect(localeFromCookieHeader('a=1; lemo_lang=ko; b=2')).toBe('ko');
    expect(localeFromCookieHeader('lemo_lang=zh')).toBe('zh');
  });

  it('没有或值不对返回 null', () => {
    expect(localeFromCookieHeader('xlemo_lang=ko')).toBeNull();
    expect(localeFromCookieHeader('lemo_lang=EN')).toBeNull();
    expect(localeFromCookieHeader('')).toBeNull();
    expect(localeFromCookieHeader(undefined)).toBeNull();
  });

  it('asLocale 只认精确值', () => {
    expect(asLocale('ko')).toBe('ko');
    expect(asLocale('KO')).toBeNull();
    expect(asLocale(' zh')).toBeNull();
  });
});

// 架构 0.31 第 12 条：profiles.ui_locale 存 zh-CN / ko-KR，传给 pickLocale 前先转
describe('fromUiLocale / toUiLocale', () => {
  it('zh-CN → zh，ko-KR → ko', () => {
    expect(fromUiLocale('zh-CN')).toBe('zh');
    expect(fromUiLocale('ko-KR')).toBe('ko');
  });

  it('别的值一律 null（App 接着往下取 pv-locale、cookie、navigator.languages）', () => {
    for (const v of [null, undefined, '', 'zh', 'ko', 'zh-cn', 'KO-KR', 'zh-TW', 'zh-Hans', 'ko_KR', ' zh-CN', 'en-US']) {
      expect(fromUiLocale(v), String(v)).toBeNull();
    }
  });

  it('toUiLocale 是 fromUiLocale 的反函数', () => {
    expect(toUiLocale('zh')).toBe('zh-CN');
    expect(toUiLocale('ko')).toBe('ko-KR');
    for (const l of ['zh', 'ko'] as const) expect(fromUiLocale(toUiLocale(l))).toBe(l);
  });

  it('不转直接传给 pickLocale 会被当成没选过（这就是要转的原因）', () => {
    expect(pickLocale('ko-KR', ['zh-CN'])).toBe('zh');
    expect(pickLocale(fromUiLocale('ko-KR'), ['zh-CN'])).toBe('ko');
  });

  it('按 0.31 的顺序取第一个有效值：ui_locale → pv-locale → cookie → navigator.languages → 中文', () => {
    const pick = (ui: string | null, pv: string | null, cookie: string | null, langs: string[]) =>
      pickLocale(fromUiLocale(ui) ?? asLocale(pv) ?? localeFromCookieHeader(cookie), langs);
    expect(pick('ko-KR', 'zh', 'lemo_lang=zh', ['zh-CN'])).toBe('ko');
    expect(pick(null, 'ko', 'lemo_lang=zh', ['zh-CN'])).toBe('ko');
    expect(pick('bad', null, 'lemo_lang=ko', ['zh-CN'])).toBe('ko');
    expect(pick(null, null, null, ['en-US', 'ko-KR'])).toBe('ko');
    expect(pick(null, null, null, ['en-US'])).toBe('zh');
  });
});
