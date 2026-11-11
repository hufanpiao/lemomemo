// 合并相近分类的本机部分（B4 S7；TC-B4-07）：哪几对该提示、用户点过“不合并”的记在 settings notes.merge_dismissed、执行合并。
// 不变量：notes.merge_dismissed 的值是 [[小 id, 大 id], …]，最多 MERGE_DISMISSED_MAX 对，满了去最旧的；点过的一对不分方向都不再提示。
//   执行合并只写被合并分类一笔 merged_into（不软删、不逐条改随手记）：条目在读的时候由 note-list.ts 的 categoryResolver 归到留下的分类。
// 纯 TS，不准 React（A1）
import { similarCategoryPairs, type MergeCategory, type MergePair } from '../../../../shared/logic/notes/category-merge.ts';
import { saveOutcome, type SaveOutcome } from '../../../core/edit-save.ts';
import { settingValue, type SettingRow, type SettingWriter } from '../../../core/setting-write.ts';
import { readonlyIds } from '../../../core/store.ts';
import { write } from '../../../core/write.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { Row } from './note-list.ts';

export const MERGE_DISMISSED_KEY = 'notes.merge_dismissed';
/** 最多记几对（一对 uuid 的 jsonb 约 88 字节，40 对约 3.5 KB，settings.value 的库约束是 4096 字节） */
export const MERGE_DISMISSED_MAX = 40;

type Pair = [string, string];
const sorted = (a: string, b: string): Pair => (a < b ? [a, b] : [b, a]);
const same = (x: Pair, y: Pair): boolean => x[0] === y[0] && x[1] === y[1];

/** 存的值 → 排好序的各对；不是数组当空，坏项丢掉 */
export function dismissedPairs(value: unknown): Pair[] {
  if (!Array.isArray(value)) return [];
  const out: Pair[] = [];
  for (const v of value as unknown[]) {
    if (!Array.isArray(v) || v.length !== 2) continue;
    const [a, b] = v as unknown[];
    if (typeof a === 'string' && typeof b === 'string' && a !== '' && b !== '' && a !== b) out.push(sorted(a, b));
  }
  return out;
}

/** 加上 (a, b) 这一对；已有就原样返回（不产生写入） */
export function withDismissed(list: readonly Pair[], a: string, b: string): readonly Pair[] {
  const p = sorted(a, b);
  if (list.some((x) => same(x, p))) return list;
  return [...list, p].slice(-MERGE_DISMISSED_MAX);
}

const mergeCategoryOf = (c: Row): MergeCategory => ({
  id: c.id,
  name: typeof c['name'] === 'string' ? c['name'] : '',
  sort: typeof c['sort'] === 'number' ? c['sort'] : 0,
  deleted_at: c['deleted_at'] == null ? null : 1,
  merged_into: typeof c['merged_into'] === 'string' ? c['merged_into'] : null,
});

/** 现在该提示的几对：相近、没撤销，且没点过“不合并” */
export function openMergePairs(categories: readonly Row[], settings: readonly SettingRow[]): MergePair[] {
  const dismissed = dismissedPairs(settingValue(settings, MERGE_DISMISSED_KEY));
  const live = categories.filter((c) => c['undone'] !== true).map(mergeCategoryOf);
  return similarCategoryPairs(live).filter((p) => !dismissed.some((x) => same(x, sorted(p.keep, p.merge))));
}

/** 用户点了“不合并”：记下这一对 */
export function dismissMerge(writer: Pick<SettingWriter, 'save'>, settings: readonly SettingRow[], pair: Pick<MergePair, 'keep' | 'merge'>): Promise<void> {
  return writer.save(MERGE_DISMISSED_KEY, withDismissed(dismissedPairs(settingValue(settings, MERGE_DISMISSED_KEY)), pair.keep, pair.merge));
}

export interface MergeDeps {
  w?: Pick<typeof write, 'patch'>;
  isReadonly?: (categoryId: string) => boolean;
}

export type MergeResult = { ok: true } | { ok: false; reason: Exclude<SaveOutcome, 'saved'> | 'gone' };

const usable = (c: Row | undefined): c is Row => !!c && c['deleted_at'] == null && c['undone'] !== true && c['merged_into'] == null;

/** 把 merge 合并进 keep：两个都要活着、不是同一个；只写 merge 一笔 {merged_into: keep} */
export async function mergeCategories(pair: Pick<MergePair, 'keep' | 'merge'>, categories: readonly Row[], deps: MergeDeps = {}): Promise<MergeResult> {
  const { w = write, isReadonly = (id: string) => readonlyIds('categories').getSnapshot().has(id) } = deps;
  const done = (r: MergeResult): MergeResult => {
    rlog(`notes merge category ${r.ok ? 'ok' : r.reason}`);
    return r;
  };
  const byId = new Map(categories.map((c) => [c.id, c]));
  if (pair.keep === pair.merge || !usable(byId.get(pair.keep)) || !usable(byId.get(pair.merge))) return done({ ok: false, reason: 'gone' });
  if (isReadonly(pair.merge)) return done({ ok: false, reason: 'readonly' });
  const r = await saveOutcome(() => w.patch('categories', pair.merge, { merged_into: pair.keep }));
  return done(r === 'saved' ? { ok: true } : { ok: false, reason: r });
}
