// 这一页用哪一套分类（负责人 11-19：隐私记的分类“隐私记自己一套”，随手记看不到；“不加密，只分开”）：
// 数据来源是隐私记（kind = 'vault'）只给 vault = true 的分类，别的来源只给随手记的。列表、编辑页、新建分类都经这里，不各自筛
import { useMemo } from 'react';
import { categoriesOf } from '../../../core/categories.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import type { Row } from '../data/note-list.ts';
import { useNoteSource } from './note-source.ts';

export function useCategoryRows(): readonly Row[] {
  const vault = useNoteSource().kind === 'vault';
  const all = useCollection<Row>('categories');
  return useMemo(() => categoriesOf(all, vault), [all, vault]);
}
