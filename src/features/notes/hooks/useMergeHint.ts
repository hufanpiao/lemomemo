// 随手记页的“合并分类”提示条（B4 S7，R-413；线框 MERGE：“‘读书’和‘书单’两个分类很像，合成一个吗？ 合并 / 不用”）
// • 要提示的几对由 data/category-merge-store.ts 的 openMergePairs 算（AI 判的 notes.merge_suggest + 本机规则，去掉点过“不用”的），一次只出第一对
// • 合并：只写被合并分类一笔 merged_into，条目读的时候归过去；成了页面底部出 8 秒撤销条，撤销就是这一对的 undo（R-415 ③：同时记成“不用”）；
//   不用：记进 notes.merge_dismissed，这一对以后不再提示
// • 暂时不出的两种（R-415 复查 N2、B4，只在本页内存里，不写库）：
//   ① 撤销条还在的那一对（shown，页面按当前撤销条传进来）：合并那一笔被服务器拒掉、本机回到没合并时，不和“已合并 · 撤销”同时出；撤销条收起就照常；
//   ② 正在撤销、撤销成了的那一对（undoing）：data 层先写 null、再记“不用”，两笔之间这一对又成了活着的，压住免得提示条闪一下、列表跳；
//      撤销回 failed（null 没写成、也没记“不用”）拿出来，以后照常提示
// • 三样的结果都换成列表页的 ActionResult（只读出“要新版本”，写不进、抛错出错条；这一对已经没了、切换账号中不提示）；
//   异常都在 data 层接住，运行日志也在 data 层记（带 merge= keep=，不记分类名）
import { useMemo, useState } from 'react';
import type { ActionResult } from '../../../core/action-result.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useSettingWriter } from '../../../kit/hooks/useSettingWriter.ts';
import { dismissMerge, mergeAction, mergeCategories, openMergePairs, undoMerge, type MergePair } from '../data/category-merge-store.ts';
import { categoryRow, type Row } from '../data/note-list.ts';

export interface MergeHint {
  /** 这一对的标识（两个分类 id 排好序，不分方向）：撤销条记着它，撤销条在时这一对不出 */
  key: string;
  /** 留下的、合并进去的分类名 */
  keepName: string;
  mergeName: string;
  merge(): Promise<ActionResult>;
  dismiss(): Promise<ActionResult>;
  /** 撤销这一对的合并：合并成了以后页面的撤销条调（提示条这时已经换下一对或没了，所以页面在合并成了的那一刻就把它拿走） */
  undo(): Promise<ActionResult>;
}

const pairKey = (p: Pick<MergePair, 'keep' | 'merge'>): string => [p.keep, p.merge].sort().join('|');
const EMPTY: ReadonlySet<string> = new Set();

/** shown：页面当前撤销条对应的那一对（没有撤销条为 null） */
export function useMergeHint(shown: string | null): MergeHint | null {
  const cats = useCollection<Row>('categories');
  const { rows: settings, writer } = useSettingWriter();
  const [undoing, setUndoing] = useState(EMPTY);
  const pair: MergePair | undefined = useMemo(
    () => openMergePairs(cats, settings).find((p) => pairKey(p) !== shown && !undoing.has(pairKey(p))),
    [cats, settings, shown, undoing],
  );
  if (!pair) return null;
  const key = pairKey(pair);
  const name = (id: string): string => {
    const c = cats.find((x) => x.id === id);
    return c ? categoryRow(c).name : '';
  };
  return {
    key,
    keepName: name(pair.keep),
    mergeName: name(pair.merge),
    merge: async () => mergeAction(await mergeCategories(pair)),
    dismiss: async () => ((await dismissMerge(writer, pair, cats)) ? 'ok' : 'failed'),
    undo: async () => {
      setUndoing((s) => new Set(s).add(key));
      const r = await undoMerge(pair, writer);
      if (r === 'failed')
        setUndoing((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        });
      return r;
    },
  };
}
