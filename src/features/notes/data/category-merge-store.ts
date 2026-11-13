// 合并相近分类的本机部分（B4 S7；TC-B4-07；R-413）：哪几对该提示、用户点过“不用”的记在 settings notes.merge_dismissed、执行合并。
// 不变量：notes.merge_dismissed 的值是 [[小 id, 大 id], …]，最多 PAIRS_MAX 对，满了去最旧的，每次写顺带去掉分类不活着的对；点过的一对不分方向都不再提示。
//   要提示的 = AI 判的（notes.merge_suggest：只有 ai-classify 写、这里的代码只读，但 RLS 不拦本人写，读时 idPairs 丢坏项）+ 本机三条规则判的，口径在 shared 的 openPairs。
//   执行合并只写被合并分类一笔 merged_into（不软删、不逐条改随手记）：条目在读的时候由 note-list.ts 的 categoryResolver 归到留下的分类
//   （列表、分类胶囊、编辑页的 formOf 都经它；新读 notes.category_id 的地方也必须经它）。
// 纯 TS，不准 React（A1）
import { isLiveCategory } from '../../../../shared/logic/live-row.ts';
import {
  idPairs, MERGE_DISMISSED_KEY, MERGE_SUGGEST_KEY, openPairs, withPairs, type MergePair,
} from '../../../../shared/logic/notes/category-merge.ts';
import { saveOutcome, type SaveOutcome } from '../../../core/edit-save.ts';
import { settingValue, type SettingRow, type SettingWriter } from '../../../core/setting-write.ts';
import { readonlyIds } from '../../../core/store.ts';
import { write } from '../../../core/write.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { Row } from './note-list.ts';

export type { MergePair };

/** 现在该提示的几对：活着的分类里 AI 判的和本机规则判的，且没点过“不用” */
export function openMergePairs(categories: readonly Row[], settings: readonly SettingRow[]): MergePair[] {
  const cats = categories.map((c) => ({
    ...c,
    name: typeof c['name'] === 'string' ? c['name'] : '',
    sort: typeof c['sort'] === 'number' ? c['sort'] : 0,
  }));
  return openPairs(cats, idPairs(settingValue(settings, MERGE_SUGGEST_KEY)), idPairs(settingValue(settings, MERGE_DISMISSED_KEY)));
}

/** 用户点了“不用”：记下这一对（在排到时的最新值上加，连点几对都记下），顺带去掉分类已经不活着的对 */
export function dismissMerge(writer: Pick<SettingWriter, 'update'>, pair: Pick<MergePair, 'keep' | 'merge'>, categories: readonly Row[]): Promise<void> {
  const live = new Set(categories.filter(isLiveCategory).map((c) => c.id));
  return writer.update(MERGE_DISMISSED_KEY, (cur) => withPairs(idPairs(cur).filter(([a, b]) => live.has(a) && live.has(b)), [[pair.keep, pair.merge]]));
}

export interface MergeDeps {
  w?: Pick<typeof write, 'patch'>;
  isReadonly?: (categoryId: string) => boolean;
}

export type MergeResult = { ok: true } | { ok: false; reason: Exclude<SaveOutcome, 'saved'> | 'gone' };

/** 把 merge 合并进 keep：两个都要活着（keep 已经合进别处的不合，免得绕成圈）、不是同一个；只写 merge 一笔 {merged_into: keep} */
export async function mergeCategories(pair: Pick<MergePair, 'keep' | 'merge'>, categories: readonly Row[], deps: MergeDeps = {}): Promise<MergeResult> {
  const { w = write, isReadonly = (id: string) => readonlyIds('categories').getSnapshot().has(id) } = deps;
  const done = (r: MergeResult): MergeResult => {
    rlog(`notes merge category ${r.ok ? 'ok' : r.reason}`);
    return r;
  };
  const byId = new Map(categories.map((c) => [c.id, c]));
  const live = (id: string): boolean => {
    const c = byId.get(id);
    return c !== undefined && isLiveCategory(c);
  };
  if (pair.keep === pair.merge || !live(pair.keep) || !live(pair.merge)) return done({ ok: false, reason: 'gone' });
  if (isReadonly(pair.merge)) return done({ ok: false, reason: 'readonly' });
  const r = await saveOutcome(() => w.patch('categories', pair.merge, { merged_into: pair.keep }));
  return done(r === 'saved' ? { ok: true } : { ok: false, reason: r });
}
