// 登录页词典（架构 2.4）：中韩键一致、占位符一致；韩文还是中文占位的每一行都标了 TODO（K4 约定）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { placeholdersOf } from '../../../../shared/i18n/i18n.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';

const HANGUL = /[가-힯]/;

describe('auth 词典', () => {
  it('中韩两份键一样、占位符一样', () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(zh).sort());
    for (const k of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(placeholdersOf(ko[k]), k).toEqual(placeholdersOf(zh[k]));
    }
  });

  it('韩文还没翻译的行（没有谚文）都标了 TODO(ko)', () => {
    const src = readFileSync(join(import.meta.dirname, '../i18n/ko.ts'), 'utf8');
    for (const line of src.split('\n').filter((l) => /^\s+'auth\./.test(l))) {
      const value = /:\s*'(.*)',/.exec(line)?.[1] ?? '';
      if (!HANGUL.test(value)) expect(line, line).toContain('TODO(ko)');
    }
  });
});
