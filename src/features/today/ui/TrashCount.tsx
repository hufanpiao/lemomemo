// 设置首页“最近删除”一组的条数（R-441）：“待办”“随手记”两行右边的值，经 today/index.ts 懒加载（设置页自己画行，同日历一行）
// 数法和“最近删除”页同一份（hooks/useTrash.ts 的 useTrashCount → data/trash.ts 的 trashOf：删了不到 30 天、不是撤销中的、不是隐私记），
// 点进 #/trash/todos、#/trash/notes 看到的就是这么多条；没有就不写数（返回 null）
import { useTrashCount } from '../hooks/useTrash.ts';

export interface TrashCountProps {
  table: 'todos' | 'notes';
  /** 有条数时怎么写（使用方给文案，例如“3 条”） */
  format(n: number): string;
}

export default function TrashCount({ table, format }: TrashCountProps) {
  const n = useTrashCount(table);
  return n > 0 ? format(n) : null;
}
