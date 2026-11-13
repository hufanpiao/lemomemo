// 随手记页的“合并分类”提示条（B4 S7，R-413；线框 MERGE：“‘读书’和‘书单’两个分类很像，合成一个吗？ 合并 / 不用”）
// • 要提示的几对由 data/category-merge-store.ts 的 openMergePairs 算（AI 判的 notes.merge_suggest + 本机规则，去掉点过“不用”的），一次只出第一对
// • 合并：只写被合并分类一笔 merged_into，条目读的时候归过去；成了页面底部出 8 秒撤销条，撤销就是这一对的 undo（R-415 ③：同时记成“不用”）；
//   不用：记进 notes.merge_dismissed，这一对以后不再提示
// • 三样的结果都换成列表页的 ActionResult（只读出“要新版本”，写不进、抛错出错条；这一对已经没了、切换账号中不提示）；
//   异常都在 data 层接住，运行日志也在 data 层记（带 merge= keep=，不记分类名）
import { useMemo } from 'react';
import type { ActionResult } from '../../../core/action-result.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useSettingWriter } from '../../../kit/hooks/useSettingWriter.ts';
import { dismissMerge, mergeAction, mergeCategories, openMergePairs, undoMerge, type MergePair } from '../data/category-merge-store.ts';
import type { Row } from '../data/note-list.ts';

export interface MergeHint {
  /** 留下的、合并进去的分类名 */
  keepName: string;
  mergeName: string;
  merge(): Promise<ActionResult>;
  dismiss(): Promise<ActionResult>;
  /** 撤销这一对的合并：合并成了以后页面的撤销条调（提示条这时已经换下一对或没了，所以页面在合并成了的那一刻就把它拿走） */
  undo(): Promise<ActionResult>;
}

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
    merge: async () => mergeAction(await mergeCategories(pair)),
    dismiss: async () => ((await dismissMerge(writer, pair, cats)) ? 'ok' : 'failed'),
    undo: () => undoMerge(pair, writer),
  };
}
