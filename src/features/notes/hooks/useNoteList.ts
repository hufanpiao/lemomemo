// 随手记页的 hook（B4 S1、S2）：条目、按天分组、分类胶囊（只在这一页筛，不写 settings）、底部输入行新建、删除和撤销
// • 新建：经 core 的 edit-save（write.insert，进 outbox、本机先生效）；先用本机规则分类（data/classify.ts，占位），ai_status 靠库里默认 pending
// • 插图（S3）：卡片顶部的图读 note_images 集合（data/note-list.ts 的 cover、images）；输入行的“图片”“拍照”先新建一条随手记
//   （正文是输入框里的字，可以空），再把图插进这一条（data/image-uploader.ts）
// • 删除：软删（deleted_at），进“最近删除”（ADR-006）；撤销把它改回 null。随手记没有提醒，remind 标记一律 false
import { useCallback, useEffect, useMemo, useState } from 'react';
import { currentTz } from '../../../core/current-tz.ts';
import { saveDeleted, saveInsert, savePatch, type SaveOutcome } from '../../../core/edit-save.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { ruleCategory } from '../data/classify.ts';
import { BODY_MAX, newNoteRow } from '../data/note-edit.ts';
import { aliveCount, categoryCounts, categoryNames, groupByDay, noteItems, type Row } from '../data/note-list.ts';

export type { NoteGroup, NoteItem } from '../data/note-list.ts';
export type ActionResult = 'ok' | 'failed' | 'readonly' | 'silent';
const resultOf = (r: SaveOutcome): ActionResult => (r === 'saved' ? 'ok' : r === 'readonly' ? 'readonly' : r === 'switching' ? 'silent' : 'failed');

const MIN = 60_000;

export function useNoteList(newId: () => string = () => crypto.randomUUID()) {
  const rows = useCollection<Row>('notes');
  const cats = useCollection<Row>('categories');
  const pics = useCollection<Row>('note_images');
  const locale = useUi((s) => s.locale);
  const [category, setCategory] = useState<string | null>(null);
  const [now, setNow] = useState(() => clock.now());
  // 每分钟重算一次（过了半夜“今天”变“昨天”）
  useEffect(() => {
    const id = setInterval(() => setNow(clock.now()), MIN);
    return () => clearInterval(id);
  }, []);
  const tz = currentTz();
  const counts = useMemo(() => categoryCounts(rows, cats, locale), [rows, cats, locale]);
  // 筛的分类没了（最后一条删掉、分类被合并）：回到“全部”
  const active = category !== null && counts.some((c) => c.id === category) ? category : null;
  const items = useMemo(() => noteItems(rows, cats, tz, active, pics), [rows, cats, tz, active, pics]);
  const groups = useMemo(() => groupByDay(items, now, tz), [items, now, tz]);

  /** 底部输入行记下一句：正文就是这句话，标题空着（列表里取正文第一行当标题）；成功回新条目的 id */
  const add = useCallback(
    async (text: string, allowEmpty = false): Promise<{ result: ActionResult; id: string | null }> => {
      const body = text.trim().slice(0, BODY_MAX);
      if (body === '' && !allowEmpty) return { result: 'silent', id: null };
      const id = newId();
      const names = categoryNames(cats);
      const cat = ruleCategory({ title: '', body }, [...names].map(([cid, name]) => ({ id: cid, name })));
      const t = clock.now();
      const r = resultOf(await saveInsert('notes', newNoteRow(id, { title: '', body, category_id: null }, t, cat), false));
      return { result: r, id: r === 'ok' ? id : null };
    },
    [cats, newId],
  );
  const remove = useCallback(
    async (id: string, deleted: boolean): Promise<ActionResult> => {
      if (!rows.some((x) => x.id === id)) return 'failed';
      return resultOf(await saveDeleted('notes', id, deleted, clock.now(), false));
    },
    [rows],
  );

  /** 撤销刚新建的一条（undone，界面和“最近删除”都不显示）：输入行插图时，图片行没写成，不留一条空随手记 */
  const discard = useCallback(async (id: string): Promise<ActionResult> => resultOf(await savePatch('notes', id, { undone: true, updated_at: clock.now() }, false)), []);
  return { items, groups, counts, category: active, setCategory, add, remove, discard, total: aliveCount(rows), now, tz };
}
