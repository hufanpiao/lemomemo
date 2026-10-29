// onboarding 词典（架构 2.4）：中韩键一致、占位符一致；韩文还是中文占位的每一行都标了 TODO(ko)；
// 隐私句和 R-115 一字不差（15.5：官网、登录页、告知页、隐私说明都用这一句）——逐字比对官网隐私说明里的那一句
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { placeholdersOf } from '../../../../shared/i18n/i18n.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';

const HANGUL = /[가-힯]/;
const ROOT = join(import.meta.dirname, '../../../..');

/** 官网隐私说明里的隐私句（去掉标签） */
function sitePrivacySentence(lang: 'zh' | 'ko', start: string): string {
  const html = readFileSync(join(ROOT, 'site', lang, 'privacy.html'), 'utf8');
  const p = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => (m[1] ?? '').replace(/<[^>]+>/g, '').trim()).find((s) => s.startsWith(start));
  if (!p) throw new Error(`site/${lang}/privacy.html 里找不到隐私句`);
  return p;
}

describe('onboarding 词典', () => {
  it('中韩两份键一样、占位符一样', () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(zh).sort());
    for (const k of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(placeholdersOf(ko[k]), k).toEqual(placeholdersOf(zh[k]));
    }
  });

  it('韩文还没翻译的行（没有谚文）都标了 TODO(ko)', () => {
    const src = readFileSync(join(import.meta.dirname, '../i18n/ko.ts'), 'utf8');
    for (const line of src.split('\n').filter((l) => /^\s+'consent\./.test(l))) {
      const value = /:\s*'(.*)',/.exec(line)?.[1] ?? '';
      if (!HANGUL.test(value)) expect(line, line).toContain('TODO(ko)');
    }
  });

  it('中文隐私句是 R-115 原句，和官网隐私说明一字不差', () => {
    expect(zh['consent.privacy']).toBe(
      '其他用户看不到你记的东西。数据存在服务器上，运营者在技术上能访问；文字、录音、图片、附件和隐私记会交给谷歌 AI 处理，预览 PPT 时文件会交给微软，详见隐私说明。',
    );
    expect(zh['consent.privacy']).toBe(sitePrivacySentence('zh', '其他用户看不到'));
  });

  it('韩文隐私句和官网韩文隐私说明一字不差', () => {
    expect(ko['consent.privacy']).toBe(sitePrivacySentence('ko', '다른 사용자는'));
  });

  it('15.5 的谷歌条款、18 岁那一句', () => {
    expect(zh['consent.terms']).toBe('按谷歌免费版条款，这些内容可能被用来改进谷歌的产品，并可能经人工审阅。使用本服务须年满 18 岁。');
  });
});
