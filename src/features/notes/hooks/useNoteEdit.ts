// 随手记编辑器的 hook：把 data/note-edit.ts 的规则接到 kit 的 useEditRecord 上
// • 标题或正文有一个不空就能保存（titleOf = 标题 + 正文）；新建第一次保存先用本机规则分类（data/classify.ts）
// • 打开一条 AI 分过、还没看过的（显示“AI”小标的）：同一页只写一次 category_seen = true，之后列表上不再出小标；
//   已删除的（页内显示“已删除”的）不写
// • 手动改分类：patchOf 同一个 patch 写 category_id、category_source = 'manual'、category_seen = true
// • 正文连续打字：所有写入经 useEditRecord 串成一条链，排在后面的 patch 在 outbox 里合并、确认回来后推进 base_rev / own_revs，
//   服务器不会把自己的上一次修改当成别人改的、不生成冲突副本（见 __tests__/NoteEditPage.test.tsx 的“连续打字不生成冲突副本”两条）
// • 读写经 ./note-source.ts 的来源（useEditRecord 的 io）：普通随手记进 outbox，隐私记进它的内存仓库和发送队列
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useEditRecord, type EditRecord } from '../../../kit/hooks/useEditRecord.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { clock } from '../../../platform/clock.ts';
import { ruleCategory } from '../data/classify.ts';
import { aiMarkKept, contentOf, emptyForm, formOf, newNoteRow, patchOf, type NoteForm } from '../data/note-edit.ts';
import { categoryOptions, showsAi, whenOf, type CategoryOption, type NoteWhen, type Row } from '../data/note-list.ts';
import { useCategoryRows } from './useCategoryRows.ts';
import { useNoteSource } from './note-source.ts';

export type { NoteForm } from '../data/note-edit.ts';
export { BODY_MAX, TITLE_MAX } from '../data/note-edit.ts';
export type { CategoryOption } from '../data/note-list.ts';

/** 这一条记下的时间（data/note-list.ts 的 whenOf；电脑抽屉顶行用，ui/note-time.ts 写成字） */
export type { NoteWhen } from '../data/note-list.ts';

export function useNoteEdit(
  id: string,
  onCreated?: (id: string) => void,
): EditRecord<NoteForm> & { change(p: Partial<NoteForm>): void; categories: CategoryOption[]; ai: boolean; when: NoteWhen | null } {
  const cats = useCategoryRows();
  const options = useMemo(() => categoryOptions(cats), [cats]);
  // 记录里的分类只按这一套解析（按全部分类解析的话，指着另一套分类的记录列表里是“没分类”、编辑页表单里却带着那个 id，保存时原样写回）
  const catsRef = useRef(cats);
  catsRef.current = cats;
  const { editIo: io } = useNoteSource();
  const rec = useEditRecord<NoteForm>({
    io,
    table: 'notes',
    id,
    formOf: (r) => formOf(r, catsRef.current),
    emptyForm,
    titleOf: contentOf,
    patchOf,
    newRow: (nid, f, now) => newNoteRow(nid, f, now, f.category_id ?? ruleCategory({ title: f.title, body: f.body }, categoryOptions(catsRef.current))),
    hasRemind: () => false,
    ...(onCreated ? { onCreated } : {}),
  });
  const { form, update, row, deleted } = rec;
  const change = useCallback((p: Partial<NoteForm>) => void update({ ...form, ...p }), [form, update]);

  // 看过了：AI 小标的那条打开就算看过，同一条只写一次
  const ai = row !== undefined && showsAi(row as Row);
  const seen = useRef<string | null>(null);
  const rowId = row ? String(row['id']) : null;
  // 只读行不写：core 也会按 readonly_row 拒，页面层先跳过
  const ro = rec.readonly;
  useEffect(() => {
    if (!ai || deleted || ro || rowId === null || seen.current === rowId) return;
    seen.current = rowId;
    void io.patch('notes', rowId, { category_seen: true, updated_at: clock.now() }, false);
  }, [ai, deleted, ro, rowId, io]);
  // 编辑器里分类旁的“AI”：这次打开时是 AI 分的、还没看过就一直标着（写了已看也不马上消失），用户手动改了分类就不标
  const aiAtOpen = useRef(false);
  if (ai) aiAtOpen.current = true;
  // 按归并后的分类比（aiMarkKept，和列表的 showsAi 一致）：AI 分到的分类后来被合并了，照样标
  const aiShown = row !== undefined && aiAtOpen.current && aiMarkKept(row, form, cats);

  const at = row?.['created_at'];
  const tz = currentTz();
  const when = typeof at === 'number' ? whenOf(at, clock.now(), tz) : null;

  return { ...rec, change, categories: options, ai: aiShown, when };
}
