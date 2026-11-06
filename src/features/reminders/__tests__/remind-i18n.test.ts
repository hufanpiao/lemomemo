// 提醒词典（B2 FA-4）：中韩两份键一样（编译期 satisfies 已查），这里查占位符一样、没有空串、韩文不混汉字、每行韩文都标 REVIEW(ko)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { remindKo } from '../i18n/ko.ts';
import { remindRowKo } from '../i18n/row-ko.ts';
import { remindRowZh } from '../i18n/row-zh.ts';
import { remindZh } from '../i18n/zh.ts';
import { tRemind } from '../hooks/useRemindT.ts';

// 首屏那几句单独一本（row-zh.ts、row-ko.ts），和整本合起来一起查
const ZH: Record<string, string> = { ...remindZh, ...remindRowZh };
const KO: Record<string, string> = { ...remindKo, ...remindRowKo };

const holes = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();

describe('提醒词典', () => {
  it('每个键中韩两份的占位符一样', () => {
    const bad = Object.keys(ZH).filter((k) => {
      const zh = ZH[k] ?? '';
      const ko = KO[k] ?? '';
      return holes(zh).join(',') !== holes(ko).join(',');
    });
    expect(bad).toEqual([]);
  });
  it('没有空串；韩文不混汉字', () => {
    for (const [k, v] of Object.entries(KO)) {
      expect(v, k).not.toBe('');
      expect(/[一-鿿]/.test(v), `${k}: ${v}`).toBe(false);
    }
    for (const [k, v] of Object.entries(ZH)) expect(v, k).not.toBe('');
  });
  it('韩文每一行都有审校标记：没审过的标 REVIEW(ko)，R-106 B2 第一遍改过的标“已审（11-04）”并写条目编号', () => {
    // 首屏那几句在 row-ko.ts，两个文件一起数
    const src = ['../i18n/ko.ts', '../i18n/row-ko.ts'].map((f) => readFileSync(join(import.meta.dirname, f), 'utf8')).join('\n');
    const lines = src.split('\n').filter((l) => /^\s+'remind\./.test(l));
    expect(lines.length).toBe(Object.keys(KO).length);
    for (const l of lines) expect(/\/\/ (REVIEW\(ko\)|R-106 B2 第一遍已审（11-04）（B2K-[S0-9]+）)/.test(l), l).toBe(true);
  });
  it('R-106 B2 韩文审校第一遍（B2K-01～04 必改、提醒词典的建议项）', () => {
    expect(remindKo['remind.set.notify.tauri']).toBe('PC 앱은 Windows 알림을 써요');
    expect(remindKo['remind.mode.onTime']).toBe('시작할 때 알림');
    for (const k of ['remind.set.inUse.remove', 'remind.set.inUse.confirmOk']) expect(remindKo[k as keyof typeof remindKo]).toBe('제거');
    // 移除设备记录一律“제거”，“로그인이 풀리다”改“로그아웃돼요”；面向用户不写“푸시”、不写“다시 해 주세요”
    for (const [k, v] of Object.entries(remindKo)) {
      if (k.startsWith('remind.set.inUse.')) expect(/지우|지웠|풀리/.test(v), `${k}: ${v}`).toBe(false);
      expect(v.includes('푸시'), `${k}: ${v}`).toBe(false);
      expect(v.includes('다시 해 주세요'), `${k}: ${v}`).toBe(false);
    }
    expect(remindKo['remind.set.inUse.confirmBody']).toContain('로그아웃되고');
    // 锁屏只显示几项：设置页说明写的“15:00 일정 1개”“할 일 1개”和实际推送同一个样子（B2K-01）
    expect(remindKo['remind.set.showTitle.note']).toContain('“15:00 일정 1개”');
  });
  it('线框原文：未同步提示、按钮文字、整页提醒“已在其他设备上处理”（R-328）', () => {
    expect(remindRowZh['remind.unsynced']).toBe('未同步，提醒可能不响');
    expect(remindZh['remind.full.handled']).toBe('已在其他设备上处理');
    // 韩文同样是中性说法：不点名“电脑”（R-328）
    expect(remindKo['remind.full.handled']).not.toContain('컴퓨터');
    expect([remindZh['remind.act.ack'], remindZh['remind.act.snooze10'], remindZh['remind.act.hour1'], remindZh['remind.act.tomorrow']]).toEqual([
      '知道了', '10 分钟后', '1 小时后', '明天再提醒',
    ]);
  });
  it('已经开始满 24 小时按天说（代码复审 N3），中韩都有', () => {
    expect(tRemind('remind.rel.startedD', { n: 1 }, 'zh-CN')).toBe('已经开始 1 天');
    expect(tRemind('remind.rel.startedD', { n: 2 }, 'ko-KR')).toBe('시작한 지 2일');
  });
});
