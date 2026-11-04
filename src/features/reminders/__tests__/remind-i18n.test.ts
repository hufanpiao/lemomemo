// 提醒词典（B2 FA-4）：中韩两份键一样（编译期 satisfies 已查），这里查占位符一样、没有空串、韩文不混汉字、每行韩文都标 REVIEW(ko)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { remindKo } from '../i18n/ko.ts';
import { remindZh } from '../i18n/zh.ts';

const holes = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();

describe('提醒词典', () => {
  it('每个键中韩两份的占位符一样', () => {
    const bad = Object.keys(remindZh).filter((k) => {
      const zh = (remindZh as Record<string, string>)[k] ?? '';
      const ko = (remindKo as Record<string, string>)[k] ?? '';
      return holes(zh).join(',') !== holes(ko).join(',');
    });
    expect(bad).toEqual([]);
  });
  it('没有空串；韩文不混汉字', () => {
    for (const [k, v] of Object.entries(remindKo)) {
      expect(v, k).not.toBe('');
      expect(/[一-鿿]/.test(v), `${k}: ${v}`).toBe(false);
    }
    for (const [k, v] of Object.entries(remindZh)) expect(v, k).not.toBe('');
  });
  it('韩文每一行都标 REVIEW(ko)（等 R-106 审校）', () => {
    const src = readFileSync(join(import.meta.dirname, '../i18n/ko.ts'), 'utf8');
    const lines = src.split('\n').filter((l) => /^\s+'remind\./.test(l));
    expect(lines.length).toBe(Object.keys(remindKo).length);
    for (const l of lines) expect(l, l).toContain('// REVIEW(ko)');
  });
  it('线框原文：未同步提示、按钮文字、整页提醒“已在其他设备上处理”（R-328）', () => {
    expect(remindZh['remind.unsynced']).toBe('未同步，提醒可能不响');
    expect(remindZh['remind.full.handled']).toBe('已在其他设备上处理');
    // 韩文同样是中性说法：不点名“电脑”（R-328）
    expect(remindKo['remind.full.handled']).not.toContain('컴퓨터');
    expect([remindZh['remind.act.ack'], remindZh['remind.act.snooze10'], remindZh['remind.act.hour1'], remindZh['remind.act.tomorrow']]).toEqual([
      '知道了', '10 分钟后', '1 小时后', '明天再提醒',
    ]);
  });
});
