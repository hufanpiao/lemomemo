// 月历词典（B2 FA-3）：中韩两份键一样（编译期 satisfies 已查），这里查每个键的占位符一样、没有空串（设计审查 L1 之外的机械检查）
import { describe, expect, it } from 'vitest';
import { viewKo } from '../i18n/view-ko.ts';
import { viewZh } from '../i18n/view-zh.ts';

const holes = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();

describe('月历词典', () => {
  it('每个键中韩两份的占位符一样', () => {
    const bad = Object.keys(viewZh).filter((k) => {
      const zh = (viewZh as Record<string, string>)[k] ?? '';
      const ko = (viewKo as Record<string, string>)[k] ?? '';
      return holes(zh).join(',') !== holes(ko).join(',');
    });
    expect(bad).toEqual([]);
  });

  it('没有空串；韩文不混中文（汉字）', () => {
    for (const [k, v] of Object.entries(viewKo)) {
      expect(v, k).not.toBe('');
      expect(/[一-鿿]/.test(v), `${k}: ${v}`).toBe(false);
    }
    for (const [k, v] of Object.entries(viewZh)) expect(v, k).not.toBe('');
  });

  it('设置摘要不提农历（负责人 11-04）；两国都显示时本国在前', () => {
    expect(viewZh['cal.set.summary']).not.toContain('农历');
    expect(viewKo['cal.set.summary']).not.toContain('음력');
    expect(viewZh['cal.set.holShort.both']).toBe('中国、韩国');
    expect(viewKo['cal.set.holShort.both']).toBe('한국·중국');
  });
});
