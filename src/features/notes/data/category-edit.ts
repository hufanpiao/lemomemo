// 改分类名、删分类（长按分类格；删分类时里面的记录不删，变回没分类）。
// 随手记、隐私记各一套（categories.vault），这里只按 id 改，查重名只在同一套里查。
// • 改名：去首尾空白、1～12 个字；同一套里名字被占着（不分大小写、没删的都算，含已合并、已撤销的，不算自己）不改，回 'dup'；和原名一样回 'ok' 不写
// • 删除：只写 deleted_at（软删除，经 outbox）。里面的记录一条都不改：category_id 还指着这个分类，
//   core/categories.ts 的 categoryResolver 遇到删了的分类回 null，列表、编辑页、分类胶囊就都当没分类（隐私记的记录在密文之外，改它要逐条重新加密，不必）
// • 运行日志：notes category rename|delete <结果码>（不记分类名）
// 纯 TS，不准 React
import { isLiveCategory } from '../../../../shared/logic/live-row.ts';
import { actionResult, type ActionResult } from '../../../core/action-result.ts';
import { categoriesOf, isVaultCategory, type Row } from '../../../core/categories.ts';
import { saveOutcome } from '../../../core/edit-save.ts';
import { collection } from '../../../core/store.ts';
import { write } from '../../../core/write.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { clampCategoryName, nameTaken } from './category-new.ts';

export type RenameResult = ActionResult | 'empty' | 'dup' | 'gone';

const live = (id: string): Row | null => collection<Row>('categories').getSnapshot().find((c) => c.id === id && isLiveCategory(c)) ?? null;

export async function renameCategory(id: string, raw: string): Promise<RenameResult> {
  const name = clampCategoryName(raw);
  if (name === '') return 'empty';
  const cur = live(id);
  if (!cur) return 'gone';
  if (String(cur['name'] ?? '') === name) return 'ok';
  // 口径同唯一索引：已合并、已撤销但没删的同名分类也占着名字
  const same = nameTaken(name, categoriesOf(collection<Row>('categories').getSnapshot(), isVaultCategory(cur)));
  if (same && same.id !== id) {
    rlog('notes category rename dup');
    return 'dup';
  }
  const r = actionResult(await saveOutcome(() => write.patch('categories', id, { name })));
  rlog(`notes category rename ${r}`);
  return r;
}

export async function deleteCategory(id: string, now: () => number = Date.now): Promise<ActionResult | 'gone'> {
  if (!live(id)) return 'gone';
  const r = actionResult(await saveOutcome(() => write.patch('categories', id, { deleted_at: now() })));
  rlog(`notes category delete ${r}`);
  return r;
}
