// 新建分类（负责人 11-19：隐私记首页方案乙的“＋ 新分类”那一格，选“做‘＋ 新分类’”；又“其他可以自己编辑分类，可以创建分类”）。
// 随手记、隐私记各一套（categories.vault，负责人 11-19“隐私记自己一套”“不加密，只分开”）：vault 建好不改。
// • 名字去掉首尾空白，1～12 个字（表约束 char_length between 1 and 12）；同一套里同名（不分大小写，活着的分类）不再建，直接回那一个；
//   名字被同一套里已合并、已撤销但没删的分类占着（表上唯一索引按 (user_id, vault, lower(name)) where deleted_at is null，它们也算）：回 'dup'，
//   不建（独立评审 11-19 高 2：原来本机当成功、服务器唯一约束拒掉，刚导入、拖进去的记录指向一个没建成的分类）
// • 经 outbox 写一行 categories（created_by = 'user'，sort 0，不给颜色：颜色和别的手建分类一样由界面按默认色画）
// • 运行日志：notes category new <结果码>|dup（不记分类名）
// 纯 TS，不准 React（A1）
import { isLiveCategory } from '../../../../shared/logic/live-row.ts';
import { actionResult, type ActionResult } from '../../../core/action-result.ts';
import { saveOutcome } from '../../../core/edit-save.ts';
import { categoriesOf, type Row } from '../../../core/categories.ts';
import { collection } from '../../../core/store.ts';
import { write } from '../../../core/write.ts';
import { rlog } from '../../../platform/run-log-api.ts';

/** 分类名最多几个字（同表约束） */
export const CATEGORY_NAME_MAX = 12;

export type NewCategory = { result: 'ok'; id: string; existed: boolean } | { result: Exclude<ActionResult, 'ok'> | 'empty' | 'dup' };

/** 起名、改名共用：去首尾空白、按字截到 CATEGORY_NAME_MAX（emoji 算一个），截完再去一次尾巴空白 */
export const clampCategoryName = (raw: string): string => [...raw.trim()].slice(0, CATEGORY_NAME_MAX).join('').trim();

/** 占着这个名字（去空白、不分大小写）的那一行：口径同表上唯一索引，没删的都算（含已合并、已撤销的） */
export function nameTaken(name: string, categories: readonly Row[]): Row | null {
  const key = name.trim().toLowerCase();
  return categories.find((c) => c['deleted_at'] == null && String(c['name'] ?? '').trim().toLowerCase() === key) ?? null;
}

export async function createCategory(raw: string, vault: boolean, newId: () => string = () => crypto.randomUUID()): Promise<NewCategory> {
  const name = clampCategoryName(raw);
  if (name === '') return { result: 'empty' };
  const taken = nameTaken(name, categoriesOf(collection<Row>('categories').getSnapshot(), vault));
  if (taken) {
    const alive = isLiveCategory(taken);
    rlog(`notes category new ${alive ? 'dup' : 'dup-hidden'}`);
    return alive ? { result: 'ok', id: taken.id, existed: true } : { result: 'dup' };
  }
  const id = newId();
  const r = actionResult(await saveOutcome(() => write.insert('categories', { id, name, sort: 0, created_by: 'user', vault })));
  rlog(`notes category new ${r}`);
  return r === 'ok' ? { result: 'ok', id, existed: false } : { result: r };
}
