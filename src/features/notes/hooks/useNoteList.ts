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
import { useSettingWriter } from '../../../kit/hooks/useSettingWriter.ts';
import { settingValue } from '../../../core/setting-read.ts';
import { useMinuteNow } from '../../../kit/hooks/useMinuteNow.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { fixCategoryCycles } from '../data/category-merge-store.ts';
import { deleteCategory, renameCategory } from '../data/category-edit.ts';
import { createCategory } from '../data/category-new.ts';
import { moveIntoCategory } from '../data/note-category.ts';
export { CATEGORY_NAME_MAX } from '../data/category-new.ts';
import { ruleCategory } from '../data/classify.ts';
import { convertNote, type ConvertResult } from '../data/note-convert.ts';
import { BODY_MAX, newNoteRow } from '../data/note-edit.ts';
import { categoryNames } from '../../../core/categories.ts';
import { aliveCount, categoryCounts, dayKind, fileCounts, groupByDay, imagesByNote, noteItems, type NoteItem } from '../data/note-list.ts';
import { orderOf } from '../../../../shared/logic/sort-key.ts';
import { applyNoteSort, planNoteDrop, type NoteKeyWrite } from '../data/note-sort.ts';
import { useCategoryRows } from './useCategoryRows.ts';
import { useNoteSource } from './note-source.ts';

export type { CategoryCount, NoteGroup, NoteItem, NoteOrder } from '../data/note-list.ts';

/** 一次拖动放下写了什么（撤销照它写回）；switched：这一次顺手从按时间切到了自己排 */
export interface NoteMove {
  writes: NoteKeyWrite[];
  switched: boolean;
}
export type { ActionResult, ConvertKind, ConvertResult };
/** 写入结果换界面码只经 core 这一份（页面的转换流程也用） */
export { actionResult };

/** 外面管的分类筛选（隐私记列表 #/vault/c/<id>：地址就是筛选，点胶囊改地址；负责人 11-19“解锁后用乙”，独立评审 11-19 中 2） */
export interface CategoryCtl {
  value: string | null;
  set: (id: string | null) => void;
}

/** cat：给了就由外面管筛哪个分类（并且在筛着的分类里记一句就记进这一类）；不给是这一页自己记着、不写 settings */
export function useNoteList(newId: () => string = () => crypto.randomUUID(), cat?: CategoryCtl) {
  const src = useNoteSource();
  const { notes: rows, images: pics, files } = src.useRows();
  const cats = useCategoryRows();
  const io = src.editIo;
  const locale = useUi((s) => s.locale);
  const [own, setOwn] = useState<string | null>(null);
  const category = cat ? cat.value : own;
  const setCategory = cat ? cat.set : setOwn;
  // 每分钟重算一次（过了半夜“今天”变“昨天”）
  const now = useMinuteNow();
  const tz = currentTz();
  // 分类合并绕成圈的写回（数据层只写一次）；来源不支持合并分类（caps.merge=false，如隐私记）不写本机分类
  const fixCycles = src.caps.merge;
  useEffect(() => {
    if (fixCycles) void fixCategoryCycles(cats);
  }, [cats, fixCycles]);
  // 活着的空分类也在里面（写 0）：刚建好的、删掉最后一条的都留着这一类（独立评审 11-19 低 23）
  const counts = useMemo(() => categoryCounts(rows, cats, locale), [rows, cats, locale]);
  // 筛的分类没了（分类被删、被合并；空分类会留着、写 0）：回到“全部”
  const active = category !== null && counts.some((c) => c.id === category) ? category : null;
  // 外面管的：地址里的分类已经没了，地址也改回“全部”，不让地址写着某一类、页面却是全部（独立评审 11-19 中 2）
  const stale = cat !== undefined && category !== null && active === null;
  useEffect(() => {
    if (stale) cat.set(null);
  }, [stale, cat]);
  const settings = useSettingWriter();
  const order = orderOf(settingValue(settings.rows, src.orderKey));
  const items = useMemo(() => noteItems(rows, cats, tz, active, pics, files, order), [rows, cats, tz, active, pics, files, order]);
  /** 没分类的条目（筛着某一类时“导入”弹窗列它们；负责人 11-19“在分类里倒入没分类的记录”“勾选多条”）；没筛分类时不算 */
  const loose = useMemo(
    () => (active === null ? [] : noteItems(rows, cats, tz, null, pics, files, order).filter((it) => it.categoryId === null)),
    [rows, cats, tz, active, pics, files, order],
  );
  /** 几条记录归进某个分类（导入、拖进分类共用）：经来源的写入口子逐条写 */
  const moveInto = useCallback((ids: readonly string[], cid: string) => moveIntoCategory(io, ids, cid), [io]);
  /** 按天分组（按时间排时的列表、瀑布流）：页面按它此刻画的顺序调（拖动中是预览顺序，R-461） */
  const byDay = useCallback((shown: readonly NoteItem[]) => groupByDay(shown, now, tz), [now, tz]);
  /** 卡片、行上的时间写“今天 / 昨天”还是日期 */
  const dayOf = useCallback((at: number) => dayKind(at, now, tz), [now, tz]);

  const fixedCat = cat ? active : null;
  /** 底部输入行记下一句：正文就是这句话，标题空着（列表里取正文第一行当标题）；成功回新条目的 id */
  const add = useCallback(
    async (text: string, allowEmpty = false): Promise<{ result: ActionResult; id: string | null }> => {
      const body = text.trim().slice(0, BODY_MAX);
      if (body === '' && !allowEmpty) return { result: 'silent', id: null };
      const id = newId();
      const names = categoryNames(cats);
      // 外面管筛选、正筛着某一类（隐私记 #/vault/c/<id>）：记进这一类，记完不会当场从列表里消失（独立评审 11-19 中 5）；否则按本机规则分
      const into = fixedCat ?? ruleCategory({ title: '', body }, [...names].map(([cid, name]) => ({ id: cid, name })));
      const t = clock.now();
      const r = actionResult(await io.insert('notes', newNoteRow(id, { title: '', body, category_id: null }, t, into), false));
      return { result: r, id: r === 'ok' ? id : null };
    },
    [cats, newId, io, fixedCat],
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

  const { convert, tooLong } = useNoteConvert();
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
  /** 新建分类（分类胶囊“＋ 新分类”；随手记、隐私记各一套分类，按数据来源分）：同名的回已有那个 */
  const vaultCats = src.kind === 'vault';
  const newCategory = useCallback((name: string) => createCategory(name, vaultCats), [vaultCats]);
  return { items, byDay, dayOf, order, counts, category: active, setCategory, add, remove, discard, convert, tooLong, move, undoMove, newCategory, renameCategory, deleteCategory, loose, moveInto, total: aliveCount(rows), now, tz };
}

/**
 * 转成待办 / 日程（R-414）和“备注放不下”：列表页（useNoteList）、编辑页“⋯”菜单共用这一份（负责人 11-20 编辑页菜单补齐）
 * • convert：keep 是弹窗问时定下的保留原条，和转换那一刻带图取或（不会说“保留”却删了原条）；结果带上 kept 给提示条用
 * • sizes(id)：这一条带几张图、几个附件（带了的转换、移进隐私记先问一次，NotesActions 的 needsAsk）
 */
export function useNoteConvert() {
  const src = useNoteSource();
  const { notes: rows, images: pics, files } = src.useRows();
  const tz = currentTz();
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
  const sizes = (id: string) => ({ images: imagesByNote(pics).get(id)?.length ?? 0, files: fileCounts(files).get(id) ?? 0 });
  return { convert, tooLong, sizes };
}
