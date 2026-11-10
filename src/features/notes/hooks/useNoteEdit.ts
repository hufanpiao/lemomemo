// 随手记编辑器的 hook（B4 S2）：把 data/note-edit.ts 的规则接到 kit 的 useEditRecord 上
// • 标题或正文有一个不空就能保存（titleOf = 标题 + 正文）；新建第一次保存先用本机规则分类（data/classify.ts，占位）
// • 打开一条 AI 分过、还没看过的（显示“AI”小标的）：同一页只写一次 category_seen = true，之后列表上不再出小标（S2）；
//   已删除的（页内显示“已删除”的）不写
// • 手动改分类：patchOf 同一个 patch 写 category_id、category_source = 'manual'、category_seen = true
// • 正文连续打字：所有写入经 useEditRecord 串成一条链，排在后面的 patch 在 outbox 里合并、确认回来后推进 base_rev / own_revs，
//   服务器不会把自己的上一次修改当成别人改的、不生成冲突副本（TC-B4-14，见 __tests__/NoteEditPage.test.tsx 的“连续打字不生成冲突副本”两条）
import { useCallback, useEffect, useRef } from 'react';
import { savePatch } from '../../../core/edit-save.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useEditRecord, type EditRecord } from '../../../kit/hooks/useEditRecord.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { clock } from '../../../platform/clock.ts';
import { todayOf, type DateStr } from '../../../../shared/core/date.ts';
import { fmtTime } from '../../../../shared/i18n/fmt.ts';
import { ruleCategory } from '../data/classify.ts';
import { contentOf, emptyForm, formOf, newNoteRow, patchOf, type NoteForm } from '../data/note-edit.ts';
import { categoryColor, categoryNames, dayKind, showsAi, type Row } from '../data/note-list.ts';

export type { NoteForm } from '../data/note-edit.ts';
export { BODY_MAX, TITLE_MAX } from '../data/note-edit.ts';

export interface CategoryOption {
  id: string;
  name: string;
  /** 分类色点的 CSS 颜色；没有就不画点 */
  color: string | null;
}

/** 这一条记下的时间：今天 / 昨天写时刻，更早的写日期（电脑抽屉顶行用） */
export interface NoteWhen {
  kind: 'today' | 'yesterday' | 'day';
  hm: string;
  date: DateStr;
}

export function useNoteEdit(
  id: string,
  onCreated?: (id: string) => void,
): EditRecord<NoteForm> & { change(p: Partial<NoteForm>): void; categories: CategoryOption[]; ai: boolean; when: NoteWhen | null } {
  const cats = useCollection<Row>('categories');
  const colorOf = new Map(cats.map((c) => [c.id, categoryColor(c['color'])]));
  const options = [...categoryNames(cats)].map(([cid, name]) => ({ id: cid, name, color: colorOf.get(cid) ?? null }));
  const optRef = useRef(options);
  optRef.current = options;
  const rec = useEditRecord<NoteForm>({
    table: 'notes',
    id,
    formOf,
    emptyForm,
    titleOf: contentOf,
    patchOf,
    newRow: (nid, f, now) => newNoteRow(nid, f, now, f.category_id ?? ruleCategory({ title: f.title, body: f.body }, optRef.current)),
    hasRemind: () => false,
    ...(onCreated ? { onCreated } : {}),
  });
  const { form, update, row, deleted } = rec;
  const change = useCallback((p: Partial<NoteForm>) => void update({ ...form, ...p }), [form, update]);

  // 看过了：AI 小标的那条打开就算看过，同一条只写一次
  const ai = row !== undefined && showsAi(row as Row);
  const seen = useRef<string | null>(null);
  const rowId = row ? String(row['id']) : null;
  useEffect(() => {
    if (!ai || deleted || rowId === null || seen.current === rowId) return;
    seen.current = rowId;
    void savePatch('notes', rowId, { category_seen: true, updated_at: clock.now() }, false);
  }, [ai, deleted, rowId]);
  // 编辑器里分类旁的“AI”：这次打开时是 AI 分的、还没看过就一直标着（写了已看也不马上消失），用户手动改了分类就不标
  const aiAtOpen = useRef(false);
  if (ai) aiAtOpen.current = true;
  const aiShown = aiAtOpen.current && row?.['category_source'] === 'ai' && form.category_id === row['category_id'];

  const at = row?.['created_at'];
  const tz = currentTz();
  const when = typeof at === 'number' ? { kind: dayKind(at, clock.now(), tz), hm: fmtTime(at, tz), date: todayOf(at, tz) } : null;

  return { ...rec, change, categories: options, ai: aiShown, when };
}
