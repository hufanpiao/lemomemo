// sync-notice 的词典（K8 冲突提示方案 3.2）：中韩占位符一样、没有空串、韩文不混汉字、韩文每行标 REVIEW(ko)；文案和方案 3.2 表一致
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORK_SUFFIX } from '../../../../shared/sync/fork-suffix-data.ts';
import { tSn } from '../hooks/useSnT.ts';
import { syncNoticeKo } from '../i18n/ko.ts';
import { syncNoticeZh } from '../i18n/zh.ts';

const ZH: Record<string, string> = syncNoticeZh;
const KO: Record<string, string> = syncNoticeKo;
const holes = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();

describe('sync-notice 词典', () => {
  it('每个键中韩两份的占位符一样', () => {
    expect(Object.keys(ZH).filter((k) => holes(ZH[k] ?? '').join() !== holes(KO[k] ?? '').join())).toEqual([]);
  });

  it('没有空串；韩文不混汉字', () => {
    for (const [k, v] of Object.entries(KO)) {
      expect(v, k).not.toBe('');
      expect(/[一-鿿]/.test(v), `${k}: ${v}`).toBe(false);
    }
    for (const [k, v] of Object.entries(ZH)) expect(v, k).not.toBe('');
  });

  it('韩文每一行都标 REVIEW(ko)', () => {
    const src = readFileSync(join(import.meta.dirname, '../i18n/ko.ts'), 'utf8');
    const lines = src.split('\n').filter((l) => /^\s+'sn\./.test(l));
    expect(lines.length).toBe(Object.keys(KO).length);
    for (const l of lines) expect(l, l).toContain('// REVIEW(ko)');
  });

  it('文案照方案 3.2（含复审三 P2 的“这条已彻底删除，无法恢复。”）', () => {
    expect(ZH['sn.gone.drop']).toBe('不用了');
    expect(KO['sn.gone.drop']).toBe('괜찮아요');
    expect(ZH['sn.hardDeleted']).toBe('这条已彻底删除，无法恢复。');
    expect(KO['sn.hardDeleted']).toBe('이 항목은 완전히 삭제되어 복원할 수 없어요.');
  });

  it('forked 说明里的后缀 trim 过（韩文复核一 R-3）：“(충돌 사본)”紧接在左引号后面', () => {
    const ko = tSn('sn.forked.body', { suffix: FORK_SUFFIX['ko-KR'].trim() }, 'ko-KR');
    expect(ko).toContain('“(충돌 사본)”');
    expect(ko).not.toContain('“ (');
    expect(tSn('sn.forked.body', { suffix: FORK_SUFFIX['zh-CN'].trim() }, 'zh-CN')).toContain('标题末尾带“（冲突副本）”。');
  });
});
