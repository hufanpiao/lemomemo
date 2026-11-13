// 随手记页的 hook（B4 S1、S2）：条目、按天分组、分类胶囊（只在这一页筛，不写 settings）、底部输入行新建、删除和撤销
// • 新建：经 core 的 edit-save（write.insert，进 outbox、本机先生效）；先用本机规则分类（data/classify.ts，占位），ai_status 靠库里默认 pending
// • 插图（S3）：卡片顶部的图读 note_images 集合（data/note-list.ts 的 cover、images）；输入行的“图片”“拍照”先新建一条随手记
//   （正文是输入框里的字，可以空），再把图插进这一条（data/image-uploader.ts）
// • 删除：软删（deleted_at），进“最近删除”（ADR-006）；撤销把它改回 null。随手记没有提醒，remind 标记一律 false
// • 转成待办 / 日程（S8，R-414）：经 data/note-convert.ts 的 convertNote；菜单变淡用 tooLong。规则见 shared/logic/notes/note-convert.ts 文件头
import { useCallback, useEffect, useMemo, useState } from 'react';
import { convertTooLong, type ConvertKind } from '../../../../shared/logic/notes/note-convert.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { actionResult, type ActionResult } from '../../../core/action-result.ts';
import { saveDeleted, saveInsert, savePatch } from '../../../core/edit-save.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useMinuteNow } from '../../../kit/hooks/useMinuteNow.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { fixCategoryCycles } from '../data/category-merge-store.ts';
import { ruleCategory } from '../data/classify.ts';
import { convertNote, type ConvertResult } from '../data/note-convert.ts';
import { BODY_MAX, newNoteRow } from '../data/note-edit.ts';
import { categoryNames } from '../../../core/categories.ts';
import { aliveCount, categoryCounts, groupByDay, imagesByNote, noteItems, type Row } from '../data/note-list.ts';

export type { NoteGroup, NoteItem } from '../data/note-list.ts';
export type { ActionResult, ConvertKind, ConvertResult };
/** 写入结果换界面码只经 core 这一份（页面的转换流程也用） */
export { actionResult };

export function useNoteList(newId: () => string = () => crypto.randomUUID()) {
  const rows = useCollection<Row>('notes');
  const cats = useCollection<Row>('categories');
  const pics = useCollection<Row>('note_images');
  const locale = useUi((s) => s.locale);
  const [category, setCategory] = useState<string | null>(null);
  // 每分钟重算一次（过了半夜“今天”变“昨天”）
  const now = useMinuteNow();
  const tz = currentTz();
  // 分类合并绕成圈的写回（数据层只写一次）
  useEffect(() => {
    void fixCategoryCycles(cats);
  }, [cats]);
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
      const r = actionResult(await saveInsert('notes', newNoteRow(id, { title: '', body, category_id: null }, t, cat), false));
      return { result: r, id: r === 'ok' ? id : null };
    },
    [cats, newId],
  );
  const remove = useCallback(
    async (id: string, deleted: boolean): Promise<ActionResult> => {
      if (!rows.some((x) => x.id === id)) return 'failed';
      return actionResult(await saveDeleted('notes', id, deleted, clock.now(), false));
    },
    [rows],
  );

  /** 撤销刚新建的一条（undone，界面和“最近删除”都不显示）：输入行插图时，图片行没写成，不留一条空随手记 */
  const discard = useCallback(async (id: string): Promise<ActionResult> => actionResult(await savePatch('notes', id, { undone: true, updated_at: clock.now() }, false)), []);

  /** 转成待办 / 日程：keep 是弹窗问时定下的保留原条，和转换那一刻带图取或（不会说“保留”却删了原条）；结果带上 kept 给提示条用 */
  const convert = useCallback(
    async (id: string, kind: ConvertKind, keep: boolean): Promise<ConvertResult & { kept: boolean }> => {
      const n = rows.find((x) => x.id === id);
      const kept = keep || imagesByNote(pics).has(id);
      if (!n) return { ok: false, reason: 'gone', kept };
      return { ...(await convertNote(n, kind, { now: clock.now(), tz, keepNote: kept })), kept };
    },
    [rows, pics, tz],
  );
  /** 这条转不了：备注放不下 */
  const tooLong = useCallback((id: string): boolean => {
    const n = rows.find((x) => x.id === id);
    return n !== undefined && convertTooLong({ title: n['title'], body: n['body'] });
  }, [rows]);
  return { items, groups, counts, category: active, setCategory, add, remove, discard, convert, tooLong, total: aliveCount(rows), now, tz };
}
