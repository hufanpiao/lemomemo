// 随手记页的 hook（B4 S1、S2）：条目、按天分组、分类胶囊（只在这一页筛，不写 settings）、底部输入行新建、删除和撤销
// • 新建：经 core 的 edit-save（write.insert，进 outbox、本机先生效）；先用本机规则分类（data/classify.ts，占位），ai_status 靠库里默认 pending
// • 插图（S3）：卡片顶部的图读 note_images 集合（data/note-list.ts 的 cover、images）；输入行的“图片”“拍照”先新建一条随手记
//   （正文是输入框里的字，可以空），再把图插进这一条（data/image-uploader.ts）
// • 删除：软删（deleted_at），进“最近删除”（ADR-006）；撤销把它改回 null。随手记没有提醒，remind 标记一律 false
// • 转成待办 / 日程（S8，R-414）：经 data/note-convert.ts 的 convertNote；菜单变淡用 tooLong。规则见 shared/logic/notes/note-convert.ts 文件头
// • 长按拖动排序（R-429）：排序方式读来源的设置键（随手记 notes.order、隐私记 vault.order，各记各的；kit 的 useSettingWriter 写）；
//   move 按页面上这一串算要写的排序值（data/note-sort.ts），按时间排时顺手切到“自己排”（switched，提示条说“已切到自己排，设置里可改回”）；
//   undoMove 写回原来的排序值，切过的再切回按时间
// • 行和写入经 ./note-source.ts 的来源（B5 隐私记重写 11-15）：普通随手记是本机集合 + edit-save，隐私记是它的内存仓库；分类照旧读本机 categories
import { useCallback, useEffect, useMemo, useState } from 'react';
import { convertTooLong, type ConvertKind } from '../../../../shared/logic/notes/note-convert.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { actionResult, type ActionResult } from '../../../core/action-result.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useSettingWriter } from '../../../kit/hooks/useSettingWriter.ts';
import { settingValue } from '../../../core/setting-read.ts';
import { useMinuteNow } from '../../../kit/hooks/useMinuteNow.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { fixCategoryCycles } from '../data/category-merge-store.ts';
import { ruleCategory } from '../data/classify.ts';
import { convertNote, type ConvertResult } from '../data/note-convert.ts';
import { BODY_MAX, newNoteRow } from '../data/note-edit.ts';
import { categoryNames } from '../../../core/categories.ts';
import { aliveCount, categoryCounts, fileCounts, groupByDay, imagesByNote, noteItems, type NoteItem, type Row } from '../data/note-list.ts';
import { orderOf } from '../../../../shared/logic/sort-key.ts';
import { applyNoteSort, planNoteDrop, type NoteKeyWrite } from '../data/note-sort.ts';
import { useNoteSource } from './note-source.ts';

export type { NoteGroup, NoteItem, NoteOrder } from '../data/note-list.ts';

/** 一次拖动放下写了什么（撤销照它写回）；switched：这一次顺手从按时间切到了自己排 */
export interface NoteMove {
  writes: NoteKeyWrite[];
  switched: boolean;
}
export type { ActionResult, ConvertKind, ConvertResult };
/** 写入结果换界面码只经 core 这一份（页面的转换流程也用） */
export { actionResult };

export function useNoteList(newId: () => string = () => crypto.randomUUID()) {
  const src = useNoteSource();
  const { notes: rows, images: pics, files } = src.useRows();
  const cats = useCollection<Row>('categories');
  const io = src.editIo;
  const locale = useUi((s) => s.locale);
  const [category, setCategory] = useState<string | null>(null);
  // 每分钟重算一次（过了半夜“今天”变“昨天”）
  const now = useMinuteNow();
  const tz = currentTz();
  // 分类合并绕成圈的写回（数据层只写一次）；来源不支持合并分类（caps.merge=false，如隐私记）不写本机分类
  const fixCycles = src.caps.merge;
  useEffect(() => {
    if (fixCycles) void fixCategoryCycles(cats);
  }, [cats, fixCycles]);
  const counts = useMemo(() => categoryCounts(rows, cats, locale), [rows, cats, locale]);
  // 筛的分类没了（最后一条删掉、分类被合并）：回到“全部”
  const active = category !== null && counts.some((c) => c.id === category) ? category : null;
  const settings = useSettingWriter();
  const order = orderOf(settingValue(settings.rows, src.orderKey));
  const items = useMemo(() => noteItems(rows, cats, tz, active, pics, files, order), [rows, cats, tz, active, pics, files, order]);
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
      const r = actionResult(await io.insert('notes', newNoteRow(id, { title: '', body, category_id: null }, t, cat), false));
      return { result: r, id: r === 'ok' ? id : null };
    },
    [cats, newId, io],
  );
  const remove = useCallback(
    async (id: string, deleted: boolean): Promise<ActionResult> => {
      if (!rows.some((x) => x.id === id)) return 'failed';
      return actionResult(await io.setDeleted('notes', id, deleted, clock.now(), false));
    },
    [rows, io],
  );

  /** 撤销刚新建的一条（undone，界面和“最近删除”都不显示）：输入行插图时，图片行没写成，不留一条空随手记 */
  const discard = useCallback(async (id: string): Promise<ActionResult> => actionResult(await src.discard(id)), [src]);

  /** 转成待办 / 日程：keep 是弹窗问时定下的保留原条，和转换那一刻带图取或（不会说“保留”却删了原条）；结果带上 kept 给提示条用 */
  const convert = useCallback(
    async (id: string, kind: ConvertKind, keep: boolean): Promise<ConvertResult & { kept: boolean }> => {
      const n = rows.find((x) => x.id === id);
      // 带图、带附件的都保留原条（D-13，R-118：新条目链回它，附件还在原处）
      const kept = keep || imagesByNote(pics).has(id) || fileCounts(files).has(id);
      // 来源不让转（隐私记）：菜单本来就不出，这里再兜一道——convertNote 写的是本机 todos / events / outbox（H4）
      if (!src.caps.convert) return { ok: false, reason: 'rejected', kept };
      if (!n) return { ok: false, reason: 'gone', kept };
      return { ...(await convertNote(n, kind, { now: clock.now(), tz, keepNote: kept })), kept };
    },
    [rows, pics, files, tz, src],
  );
  /** 这条转不了：备注放不下 */
  const tooLong = useCallback((id: string): boolean => {
    const n = rows.find((x) => x.id === id);
    return n !== undefined && convertTooLong({ title: n['title'], body: n['body'] });
  }, [rows]);
  /** 拖动放下（R-429）：shown 是页面上这一串（显示顺序）；没什么要写回 null */
  const move = async (shown: readonly NoteItem[], id: string, index: number): Promise<{ res: ActionResult; plan: NoteMove } | null> => {
    const switched = order !== 'manual';
    const writes = planNoteDrop(shown, id, index, clock.now(), switched);
    if (writes.length === 0) return null;
    if (switched) void settings.save(src.orderKey, 'manual');
    return { res: await applyNoteSort(io, writes, false), plan: { writes, switched } };
  };
  const undoMove = async (m: NoteMove): Promise<ActionResult> => {
    if (m.switched) void settings.save(src.orderKey, 'time');
    return applyNoteSort(io, m.writes, true);
  };
  return { items, groups, order, counts, category: active, setCategory, add, remove, discard, convert, tooLong, move, undoMove, total: aliveCount(rows), now, tz };
}
