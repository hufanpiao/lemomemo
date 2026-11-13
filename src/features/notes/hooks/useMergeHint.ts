// 随手记页的“合并分类”提示条（B4 S7，R-413；线框 MERGE：“‘读书’和‘书单’两个分类很像，合成一个吗？ 合并 / 不用”）
// • 要提示的几对由 data/category-merge-store.ts 的 openMergePairs 算（AI 判的 notes.merge_suggest + 本机规则，去掉点过“不用”的），一次只出第一对
// • 合并：只写被合并分类一笔 merged_into，条目读的时候归过去；成了页面底部出 8 秒撤销条（R-415 ③，撤销是 data 的 undoMerge）；
//   不用：记进 notes.merge_dismissed，这一对以后不再提示
// • 结果换成列表页的 ActionResult（只读出“要新版本”，写不进出错条；这一对已经没了、切换账号中不提示）；“不用”没写进本机或抛错都出错条，运行日志只记结果
import { useMemo } from 'react';
import type { ActionResult } from '../../../core/action-result.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useSettingWriter } from '../../../kit/hooks/useSettingWriter.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { dismissMerge, mergeCategories, openMergePairs, type MergePair, type MergeResult } from '../data/category-merge-store.ts';
import type { Row } from '../data/note-list.ts';

/** 撤销条上的“撤销”（R-415 ③）：合并之后提示条已经换下一对或没了，撤销不经 MergeHint，页面直接调 */
export { undoMerge } from '../data/category-merge-store.ts';

export interface MergeHint {
  /** 留下的、合并进去的分类名 */
  keepName: string;
  mergeName: string;
  /** 被合并的分类 id：合并成了页面出撤销条（R-415 ③），撤销写回它的 merged_into */
  mergeId: string;
  merge(): Promise<ActionResult>;
  dismiss(): Promise<ActionResult>;
}

const resultOf = (r: MergeResult): ActionResult =>
  r.ok ? 'ok' : r.reason === 'readonly' ? 'readonly' : r.reason === 'gone' || r.reason === 'switching' ? 'silent' : 'failed';

export function useMergeHint(): MergeHint | null {
  const cats = useCollection<Row>('categories');
  const { rows: settings, writer } = useSettingWriter();
  const pair: MergePair | undefined = useMemo(() => openMergePairs(cats, settings)[0], [cats, settings]);
  if (!pair) return null;
  const name = (id: string): string => {
    const v = cats.find((c) => c.id === id)?.['name'];
    return typeof v === 'string' ? v : '';
  };
  return {
    keepName: name(pair.keep),
    mergeName: name(pair.merge),
    mergeId: pair.merge,
    merge: async () => resultOf(await mergeCategories(pair, cats)),
    dismiss: async () => {
      const ok = await dismissMerge(writer, pair, cats).catch(() => false);
      rlog(`notes merge dismiss ${ok ? 'ok' : 'fail'}`);
      return ok ? 'ok' : 'failed';
    },
  };
}
