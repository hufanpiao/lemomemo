// 随手记手机排法的分类那一排（负责人 11-19“其他可以自己编辑分类，可以创建分类”；隐私记分类列表顶上同一排）：
// • “全部 N”、每个分类（空的写 0）、最后一个“＋ 新分类”（建好就筛到这一类）
// • 长按某个分类（电脑右键）出“分类‘X’”弹窗（弹窗由列表页挂一份，useCategoryDialogs）：改名、删除（删除再问一次，里面的记录不删、变回没分类）；“全部”“＋”不长按
// • 哪一套分类由 useNoteList 按数据来源分（隐私记只列、只建隐私记的）
// • 每个分类胶囊也是拖进目标（data-drop-into）：列表里没分类的那一条长按拖到胶囊上松手，归进这一类（负责人 11-19“里面的记录可以拖进分类里面”）
// 运行日志：notes cat hold（长按出菜单）；新建、改名、删除的结果由 data 层记
import { useLongPress } from '../../../motion/gestures.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { CategoryCount, useNoteList } from '../hooks/useNoteList.ts';
import { useNotesT } from '../hooks/useNotesT.ts';
import type { CategoryDialogs } from './CategoryDialogs.tsx';
import { Chip } from './NotesBits.tsx';
import chip from '../../../kit/components/Chip.module.css';
import { Pressable } from '../../../motion/components.ts';

function CatChip({ c, on, pick, edit }: { c: CategoryCount; on: boolean; pick(): void; edit(c: CategoryCount): void }) {
  const hold = useLongPress(() => {
    rlog('notes cat hold');
    edit(c);
  });
  return <Chip on={on} onClick={pick} label={`${c.name} ${c.count}`} n={c.count} color={c.color} testId={`notes-filter-${c.id}`} hold={hold} drop={c.id} />;
}

type List = Pick<ReturnType<typeof useNoteList>, 'counts' | 'category' | 'setCategory' | 'total'>;

/** cd：列表页挂的那一份分类弹窗（useCategoryDialogs） */
export function CatChips({ l, cd, className }: { l: List; cd: Pick<CategoryDialogs, 'add' | 'edit'>; className: string | undefined }) {
  const t = useNotesT();
  return (
    <div className={className} role="group" aria-label={t('notes.filter', {})} data-testid="notes-filter">
      <Chip on={l.category === null} onClick={() => l.setCategory(null)} label={t('notes.all', { n: l.total })} n={l.total} color={null} testId="notes-filter-all" />
      {l.counts.map((c) => (
        <CatChip key={c.id} c={c} on={l.category === c.id} pick={() => l.setCategory(c.id)} edit={cd.edit} />
      ))}
      <Pressable className={chip.chip} onClick={cd.add} data-testid="notes-filter-new">
        {t('notes.cat.new', {})}
      </Pressable>
    </div>
  );
}
