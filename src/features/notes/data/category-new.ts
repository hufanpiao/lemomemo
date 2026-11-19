// 新建分类（负责人 11-19：隐私记首页方案乙的“＋ 新分类”那一格，选“做‘＋ 新分类’”）。随手记、隐私记共用这一套分类（categories 表）。
// • 名字去掉首尾空白，1～12 个字（表约束 char_length between 1 and 12）；同名（不分大小写，活着的分类）不再建，直接回那一个（表上有唯一索引）
// • 经 outbox 写一行 categories（created_by = 'user'，sort 0，不给颜色：颜色和别的手建分类一样由界面按默认色画）
// • 运行日志：notes category new <结果码>|dup（不记分类名）
// 纯 TS，不准 React（A1）
import { isLiveCategory } from '../../../../shared/logic/live-row.ts';
import { actionResult, type ActionResult } from '../../../core/action-result.ts';
import type { Row } from '../../../core/categories.ts';
import { saveOutcome } from '../../../core/edit-save.ts';
import { collection } from '../../../core/store.ts';
import { write } from '../../../core/write.ts';
import { rlog } from '../../../platform/run-log-api.ts';

/** 分类名最多几个字（同表约束） */
export const CATEGORY_NAME_MAX = 12;

export type NewCategory = { result: 'ok'; id: string; existed: boolean } | { result: Exclude<ActionResult, 'ok'> | 'empty' };

/** 同名（去空白、不分大小写）活着的分类 */
export function sameNameCategory(name: string, categories: readonly Row[]): Row | null {
  const key = name.trim().toLowerCase();
  return categories.find((c) => isLiveCategory(c) && String(c['name'] ?? '').trim().toLowerCase() === key) ?? null;
}

export async function createCategory(raw: string, newId: () => string = () => crypto.randomUUID()): Promise<NewCategory> {
  const name = [...raw.trim()].slice(0, CATEGORY_NAME_MAX).join('');
  if (name === '') return { result: 'empty' };
  const dup = sameNameCategory(name, collection<Row>('categories').getSnapshot());
  if (dup) {
    rlog('notes category new dup');
    return { result: 'ok', id: dup.id, existed: true };
  }
  const id = newId();
  const r = actionResult(await saveOutcome(() => write.insert('categories', { id, name, sort: 0, created_by: 'user' })));
  rlog(`notes category new ${r}`);
  return r === 'ok' ? { result: 'ok', id, existed: false } : { result: r };
}
