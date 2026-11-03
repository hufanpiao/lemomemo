// 编辑页共用的“表单 ↔ 一行记录”（B2 FA-2：日程、待办编辑页）：改了就保存，不弹窗（定稿线框“改了就自动保存”）
// • 显示的表单 = 集合里那一行的表单（新建时是空表单），叠上用户改了、还没保存上的那几个字段（dirty）。
//   别的设备改了别的字段、同步进来，页面跟着变；用户改过、没保存上的字段不被覆盖
// • 每次写入带上用户改过、还没保存上的全部字段（代码审查 N1，取代 S12 的“只带这一次”）：“这一次改了哪些”= 改之前显示的表单和改之后比，
//   含 normalize 连带清掉的列；再加上 dirty 里以前没写进去的（closing、local_unavailable 等）。否则先改标题没写进去、再改备注
//   只发备注却显示“已保存”，标题其实丢了
// • 被拒（rejected，校验不过）的字段单独记（值钉住），下次不带；用户再改这个字段就解除。一次带了旧字段又被拒、分不清是谁：
//   只拿这一次的改动重试一次——成了就是旧字段的锅，失败就是这一次的。还有被拒、没写进去的字段时，状态不报 saved
// • 所有写入（update、setDeleted）串成一条链（S1，提为必改）：前一次回来才开始下一次，顺序不靠 IndexedDB 碰巧的执行顺序；
//   状态只认最后一次（seq），前一次晚回来不改状态（S9）
// • 新建：标题为空时不写（状态 empty_title）；第一次有标题时 insert 整行，之后同一页再改都是 patch；insert 失败就忘掉这个 id，
//   下一次改动重新 insert。insert 成功后调 onCreated（页面把地址换成这一条的 id，S7）
// • 没写进去（local_unavailable / closing / readonly / rejected）：保留输入、状态写原因；switching 不提示（页面马上跳走）
// • 时刻、时区：now 取 platform/clock（带偏差校正，K8-clock），浮动时刻按 core 的 currentTz
// • 删除、撤销删除：软删（deleted_at），撤销把它改回 null（ADR-006）；也算 remind 标记（补审改法 ④）
// • remind 标记由 spec.hasRemind 按“这一行、这次实际写出去的列”算（prevRemindAt 传不传在 data 层，补审改法 ①～③）
import { useCallback, useRef, useState } from 'react';
import type { Tz } from '../../../shared/core/tz.ts';
import { currentTz } from '../../core/current-tz.ts';
import { saveDeleted, saveInsert, savePatch, type SaveOutcome } from '../../core/edit-save.ts';
import { clock } from '../../platform/clock.ts';
import { useItem } from './useItem.ts';

export type EditStatus = 'idle' | 'saving' | 'empty_title' | 'missing' | SaveOutcome;

type AnyRow = Readonly<Record<string, unknown>>;

/** 算 remind 标记要的东西：row = 写之前的那一行（新建为 undefined）；data = 这次 patch（insert 为 null）；prev / next = 写之前 / 之后的表单 */
export interface RemindCtx<F> {
  row: AnyRow | undefined;
  data: Record<string, unknown> | null;
  prev: F | null;
  next: F;
  tz: Tz;
  now: number;
}

export interface EditRecordSpec<F> {
  table: string;
  /** 路由里的 id；'new' = 新建 */
  id: string;
  formOf(row: AnyRow): F;
  emptyForm(): F;
  titleOf(form: F): string;
  patchOf(row: AnyRow, prev: F, next: F, now: number): Record<string, unknown> | null;
  newRow(id: string, form: F, now: number): Record<string, unknown> & { id: string };
  hasRemind(c: RemindCtx<F>): boolean;
  /** 新建的这一行 insert 成功（页面换地址用） */
  onCreated?(id: string): void;
  newId?: () => string;
  now?: () => number;
  tz?: () => Tz;
}

export interface EditRecord<F> {
  /** 集合里的那一行（新建还没保存时为 undefined） */
  row: AnyRow | undefined;
  form: F;
  isNew: boolean;
  /** 保存过的 id（新建保存后才有） */
  savedId: string | null;
  deleted: boolean;
  status: EditStatus;
  update(next: F): Promise<EditStatus>;
  setDeleted(deleted: boolean): Promise<EditStatus>;
  /** 调用方自己拦下了这次修改（比如时区不在白名单）：状态报 rejected，不写 */
  markRejected(): void;
}

/** next 和 shown 不一样的字段（字段值都是字符串、数字、布尔、null） */
function changedOf<F>(shown: F, next: F): Partial<F> {
  const out: Partial<F> = {};
  for (const k of Object.keys(next as object) as (keyof F)[]) if (!Object.is(next[k], shown[k])) out[k] = next[k];
  return out;
}

export function useEditRecord<F>(spec: EditRecordSpec<F>): EditRecord<F> {
  const isNewRoute = spec.id === 'new';
  const [createdId, setCreatedId] = useState<string | null>(null);
  const recordId = isNewRoute ? createdId : spec.id;
  const row = useItem<{ id: string } & Record<string, unknown>>(spec.table, recordId);
  const [dirty, setDirtyState] = useState<Partial<F>>({});
  const [status, setStatus] = useState<EditStatus>('idle');
  // 新建页的空表单只造一次（日期默认值等不随重画变）
  const empty = useRef<F | null>(null);
  empty.current ??= spec.emptyForm();
  const specRef = useRef(spec);
  specRef.current = spec;

  // 新建：insert 成功的 id、以及最后写进去的那份表单（行还没从集合读回来时当对比基准，也当显示的底子，免得标题闪空）
  const created = useRef<string | null>(null);
  const sentForm = useRef<F | null>(null);
  // 被拒的字段和被拒的那个值（N1）：dirty 里还是这个值就不再带
  const rejected = useRef<Partial<F>>({});

  const base = row ? spec.formOf(row) : (sentForm.current ?? (empty.current as F));
  const form = { ...base, ...dirty } as F;
  const missing = !isNewRoute && row === undefined && createdId === null;

  // 写的时候要读“那一刻”的值，不读闭包里旧的：行、显示的表单、dirty 都放 ref
  const live = useRef({ row, form, dirty, isNewRoute });
  live.current = { row, form, dirty, isNewRoute };
  const dirtyRef = useRef(dirty);
  const setDirty = useCallback((f: (d: Partial<F>) => Partial<F>) => {
    dirtyRef.current = f(dirtyRef.current);
    setDirtyState(dirtyRef.current);
  }, []);

  const seq = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    const p = chain.current.then(job, job);
    chain.current = p.catch(() => undefined);
    return p;
  }, []);

  const update = useCallback(
    (next: F): Promise<EditStatus> => {
      const s = specRef.current;
      const mine = ++seq.current;
      // 这一次改了哪些：和改之前显示的表单比（含 normalize 连带的列）
      const changed = changedOf(live.current.form, next);
      setDirty((d) => ({ ...d, ...changed }));
      // 改这一下那一刻还没保存上的全部字段（排在后面的改动不提前带；被拒的到写的时候再筛）
      const unsaved = dirtyRef.current;
      if (s.titleOf(next).trim() === '') {
        setStatus('empty_title');
        return Promise.resolve('empty_title' as const);
      }
      setStatus('saving');
      for (const k of Object.keys(changed) as (keyof F)[]) delete rejected.current[k];
      return enqueue(async (): Promise<EditStatus> => {
        const now = s.now ? s.now() : clock.now();
        const tz = s.tz ? s.tz() : currentTz();
        const ctx: PatchCtx<F> = { s, live: live.current, created: created.current, sentForm, now, tz };
        let r: SaveOutcome;
        if (live.current.row || created.current !== null) {
          // 这一次的改动，加上改的那一刻以前没写进去、也没被拒的字段
          // （前面排着的写入已经写上的，dirty 里已拿掉，不再带）
          const fields = { ...pendingOf(unsaved, dirtyRef.current, rejected.current), ...changed };
          let sent: Partial<F> = fields;
          r = await patchFields(ctx, fields);
          if (r === 'rejected') {
            const carried = omitKeys(fields, changed);
            if (Object.keys(carried).length > 0) {
              sent = changed;
              r = await patchFields({ ...ctx, live: live.current }, changed);
              Object.assign(rejected.current, r === 'saved' ? carried : changed);
            } else Object.assign(rejected.current, changed);
          }
          if (r === 'saved') setDirty((d) => withoutSent(d, sent));
        } else if (!live.current.isNewRoute) {
          if (mine === seq.current) setStatus('missing');
          return 'missing';
        } else {
          // 第一次：insert 整行（新建页没有别人的修改要防，整张表单就是这一次要写的）
          const id = (s.newId ?? (() => crypto.randomUUID()))();
          const whole = { ...(empty.current as F), ...dirtyRef.current } as F;
          r = await saveInsert(s.table, s.newRow(id, whole, now), s.hasRemind({ row: undefined, data: null, prev: null, next: whole, tz, now }));
          if (r === 'saved') {
            created.current = id;
            sentForm.current = whole;
            setCreatedId(id);
            s.onCreated?.(id);
            setDirty((d) => withoutSent(d, whole));
          }
        }
        // 写成了，但还有被拒的字段没写进去：不报 saved
        const out: EditStatus = r === 'saved' && hasRejected(dirtyRef.current, rejected.current) ? 'rejected' : r;
        if (mine === seq.current) setStatus(out);
        return out;
      });
    },
    [enqueue, setDirty],
  );

  const setDeleted = useCallback(
    (deleted: boolean): Promise<EditStatus> => {
      const mine = ++seq.current;
      setStatus('saving');
      return enqueue(async (): Promise<EditStatus> => {
        const s = specRef.current;
        const cur = live.current.row;
        if (!cur) {
          if (mine === seq.current) setStatus('missing');
          return 'missing';
        }
        const now = s.now ? s.now() : clock.now();
        const tz = s.tz ? s.tz() : currentTz();
        const f = s.formOf(cur);
        const remind = s.hasRemind({ row: cur, data: { deleted_at: deleted ? now : null }, prev: f, next: f, tz, now });
        const r = await saveDeleted(s.table, cur.id, deleted, now, remind);
        if (mine === seq.current) setStatus(r);
        return r;
      });
    },
    [enqueue],
  );

  const markRejected = useCallback((): void => {
    ++seq.current;
    setStatus('rejected');
  }, []);

  return {
    row,
    form,
    isNew: isNewRoute && createdId === null,
    savedId: recordId,
    deleted: row !== undefined && row['deleted_at'] !== null && row['deleted_at'] !== undefined,
    status: missing && status === 'idle' ? 'missing' : status,
    update,
    setDeleted,
    markRejected,
  };
}

interface PatchCtx<F> {
  s: EditRecordSpec<F>;
  live: { row: AnyRow | undefined };
  created: string | null;
  sentForm: { current: F | null };
  now: number;
  tz: Tz;
}

/** 按 patch 写 fields：有行就和行比；insert 成功、行还没读回来就和刚写进去的那份比（成了顺手更新它） */
async function patchFields<F>(c: PatchCtx<F>, fields: Partial<F>): Promise<SaveOutcome> {
  const { s, now, tz } = c;
  const cur = c.live.row;
  const id = cur ? String(cur['id']) : (c.created as string);
  const prev = cur ? s.formOf(cur) : (c.sentForm.current as F);
  const rowNow = cur ?? s.newRow(id, prev, now);
  const target = { ...prev, ...fields } as F;
  const data = s.patchOf(rowNow, prev, target, now);
  const r = data ? await savePatch(s.table, id, data, s.hasRemind({ row: rowNow, data, prev, next: target, tz, now })) : 'saved';
  if (r === 'saved' && !cur) c.sentForm.current = target;
  return r;
}

/** 改的那一刻没保存上的字段里，现在还没写上（dirty 里还是那个值）、也没被拒的（被拒的值钉住：用户改成别的值就不算被拒） */
function pendingOf<F>(then: Partial<F>, now: Partial<F>, rej: Partial<F>): Partial<F> {
  const out: Partial<F> = {};
  for (const k of Object.keys(then) as (keyof F)[]) {
    if (k in now && Object.is(now[k], then[k]) && !(k in rej && Object.is(rej[k], then[k]))) out[k] = then[k];
  }
  return out;
}

function hasRejected<F>(d: Partial<F>, rej: Partial<F>): boolean {
  return (Object.keys(d) as (keyof F)[]).some((k) => k in rej && Object.is(rej[k], d[k]));
}

function omitKeys<F>(a: Partial<F>, b: Partial<F>): Partial<F> {
  const out: Partial<F> = { ...a };
  for (const k of Object.keys(b) as (keyof F)[]) delete out[k];
  return out;
}

/** 写成功后从 dirty 里拿掉已经写上的字段（值还是写出去的那个才拿掉；之后又改了的留着） */
function withoutSent<F>(d: Partial<F>, sent: Partial<F>): Partial<F> {
  const out: Partial<F> = { ...d };
  for (const k of Object.keys(sent) as (keyof F)[]) if (Object.is(out[k], sent[k])) delete out[k];
  return out;
}
