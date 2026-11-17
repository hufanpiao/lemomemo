// 提示条上一批的撤销、合并（data/saved-batch.ts；FA-3 复查第 3、4 条）；确认行连点（第二轮复查续第 2 条）
// 纪念日在这里撤不掉（capture-save 的 undoRefs 一律留下）：不算“没撤销成功”，单独一句“纪念日请到纪念日页删除”；
// 全部撤销、逐条撤销时那一条留在提示条上，合并成功后不留（R-405）
// 附加句的条数按这一批现算（撤过没撤成的标 undoTried）；会写库的操作共用一把锁，fresh / closeNotice 换代号后之前的不写回；
// 单条撤成过不再给合并；合并后的新提示条不带原来的提示；额度提示在存成那一刻定（整块评审第 1～4、12 条）
// AI 后台整理换掉先存的（R-456 replace）：和合并同一个先存新、再撤旧；一样不换、动过不换、新的没存上原样留着
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import type { WriteResult } from '../../../core/write.ts';
import type { Writer } from '../data/capture-save.ts';
import { QUOTA_NOTICE_KEY } from '../data/quota.ts';
import type { TypePlan } from '../data/type-flow.ts';
import { createBatchBox, createSavedBatch, noticeOf, sameItems, type Batch, type BatchEntry } from '../data/saved-batch.ts';

const OK: WriteResult = { ok: true, item: null };
const FAIL: WriteResult = { ok: false, reason: 'local_unavailable' };
const NOW = Date.UTC(2026, 10, 2, 3);
const todo = (title: string): AiItem => ({
  kind: 'todo', title, date: null, time: null, duration_min: null, due: null, important: false,
  project: null, body: null, short: null, date_basis: null, anniv: null, confirm: null,
}) as AiItem;
const PLAN = { status: 'saved', origin: 'rule', items: [], hints: { recur: false, arrange: false, bad_day: null }, quotaLeft: null, aiReason: null } as unknown as TypePlan;

const t1: BatchEntry = { ref: { table: 'todos', id: 't1', title: '买牛奶' }, item: todo('买牛奶') };
const t2: BatchEntry = { ref: { table: 'todos', id: 't2', title: '交电费' }, item: todo('交电费') };
const t3: BatchEntry = { ref: { table: 'todos', id: 't3', title: '寄快递' }, item: todo('寄快递') };
const a1: BatchEntry = { ref: { table: 'anniversaries', id: 'a1', title: '妈妈生日' }, item: todo('妈妈生日') };

function batchOf(entries: BatchEntry[] = [t1, t2, a1], plan: TypePlan = PLAN): Batch {
  return { batchId: 'b1', raw: '买牛奶，交电费，妈妈生日', remind: false, plan, entries, stored: entries.length, last: null };
}

/** 写入口桩：patch 按 id 给结果（patchFail 里的写不进去，别的 OK） */
function setup(entries?: BatchEntry[], plan?: TypePlan) {
  const patchFail = new Set<string>();
  const writer = {
    insert: vi.fn<Writer['insert']>(async () => OK),
    patch: vi.fn<Writer['patch']>(async (_t, id) => (patchFail.has(id) ? FAIL : OK)),
  };
  const box = createBatchBox();
  box.setState({ batch: batchOf(entries, plan) });
  const flow = { go: vi.fn(), done: vi.fn(), fail: vi.fn(), error: vi.fn() };
  /** 库里每一条的样子（id → 版本）：测试里改它就等于“在别处改过” */
  const rows = new Map<string, string | null>();
  const peek = (ref: { id: string }): string | null => (rows.has(ref.id) ? (rows.get(ref.id) ?? null) : 'v0');
  const b = createSavedBatch({ box, writer, tag: 'test', env: () => ({ now: NOW, tz: 'Asia/Seoul', day: null }), flow, peek });
  const notice = () => noticeOf(box.getState());
  const keys = (): string[] => notice()?.lines.map((l) => l.key) ?? [];
  const line = (key: string) => notice()?.lines.find((l) => l.key === key);
  const ids = (): string[] => notice()?.entries.map((e) => e.ref.id) ?? [];
  return { writer, b, notice, keys, line, ids, flow, box, patchFail, rows };
}

/** 让写入口下一次调用卡住，返回放开它的函数 */
function hangNext(fn: { mockImplementationOnce(f: () => Promise<WriteResult>): unknown }): { open(): void } {
  const gate = { open: (): void => undefined };
  fn.mockImplementationOnce(() => new Promise<WriteResult>((ok) => (gate.open = () => ok(OK))));
  return gate;
}

beforeEach(() => localStorage.removeItem(QUOTA_NOTICE_KEY));
afterEach(() => vi.restoreAllMocks());

describe('一批里有纪念日', () => {
  it('全部撤销：撤掉别的，纪念日留在提示条上、单独一句，不算没撤成；再点一次也一样', async () => {
    const { writer, b, notice, keys, flow } = setup();
    await b.undo();
    expect(flow.go, '没有真正失败的：停在结局的回到 idle').toHaveBeenCalledWith({ type: 'cleared' });
    expect(writer.patch).toHaveBeenCalledTimes(2);
    expect(notice()?.entries.map((e) => e.ref.id)).toEqual(['a1']);
    expect(keys()).toContain('plus.notice.annivKept');
    expect(keys()).not.toContain('plus.notice.undoFailed');
    await b.undo();
    expect(flow.go).toHaveBeenCalledTimes(2);
    expect(keys()).toContain('plus.notice.annivKept');
    expect(keys()).not.toContain('plus.notice.undoFailed');
  });

  it('合并成一条：新的一条存上、别的撤掉；纪念日撤不掉，不留在提示条上、不算条数，只单独一句（负责人 11-13 定，待定 23、R-405）', async () => {
    const { writer, b, notice, keys } = setup();
    await b.merge();
    expect(writer.insert).toHaveBeenCalledTimes(1);
    expect(writer.patch).toHaveBeenCalledTimes(2);
    const ids = notice()?.entries.map((e) => e.ref.id) ?? [];
    expect(ids).toHaveLength(1);
    expect(ids).not.toContain('a1');
    expect(keys()).not.toContain('plus.notice.savedN');
    expect(keys()).toContain('plus.notice.annivKept');
    expect(keys()).not.toContain('plus.notice.undoFailed');
  });

  it('逐条撤销纪念日：撤不掉，提示条说一句，不悄悄没反应', async () => {
    const { writer, b, notice, keys } = setup();
    await b.undoOne('a1');
    expect(writer.patch).not.toHaveBeenCalled();
    expect(notice()?.entries).toHaveLength(3);
    expect(keys()).toContain('plus.notice.annivKept');
  });
});

describe('附加句的条数按这一批现算（整块评审第 1、2 条）', () => {
  it('全部撤销 2 条没撤成 → “2 条”；再单条撤成一条 → 跟着变成“1 条”', async () => {
    const { b, line, ids, patchFail } = setup([t1, t2, t3]);
    patchFail.add('t1').add('t2');
    await b.undo();
    expect(ids()).toEqual(['t1', 't2']);
    expect(line('plus.notice.undoFailed')?.params).toEqual({ n: 2 });
    patchFail.delete('t1');
    await b.undoOne('t1');
    expect(ids()).toEqual(['t2']);
    expect(line('plus.notice.undoFailed')?.params).toEqual({ n: 1 });
  });

  it('全部撤销 2 条没撤成，再单条撤一条又没撤成：别的那条的“没撤成”不清零，还是“2 条”', async () => {
    const { b, line, patchFail } = setup([t1, t2, t3]);
    patchFail.add('t1').add('t2');
    await b.undo();
    await b.undoOne('t1');
    expect(line('plus.notice.undoFailed')?.params).toEqual({ n: 2 });
  });

  it('纪念日混在里面：全部撤销后单条撤另一条没撤成，纪念日那句还在、条数照算', async () => {
    const { b, keys, line, ids, patchFail } = setup([t1, t2, a1]);
    patchFail.add('t1');
    await b.undo();
    expect(ids()).toEqual(['t1', 'a1']);
    await b.undoOne('t1');
    expect(keys()).toContain('plus.notice.annivKept');
    expect(line('plus.notice.undoFailed')?.params).toEqual({ n: 1 });
    patchFail.delete('t1');
    await b.undoOne('t1');
    expect(ids()).toEqual(['a1']);
    expect(keys()).toContain('plus.notice.annivKept');
    expect(keys()).not.toContain('plus.notice.undoFailed');
  });
});

describe('会写库的操作共用一把锁、换代号后不写回（整块评审第 3 条）', () => {
  it('快速点两行“撤销”：第一行还没撤完时第二下不理，先撤掉的不会回到提示条上', async () => {
    const { writer, b, ids } = setup([t1, t2, t3]);
    const gate = hangNext(writer.patch);
    const first = b.undoOne('t1');
    const second = b.undoOne('t2');
    await vi.waitFor(() => expect(writer.patch).toHaveBeenCalledTimes(1));
    gate.open();
    await Promise.all([first, second]);
    expect(writer.patch).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual(['t2', 't3']);
  });

  it('“合并”连点两下：只存一条合并条', async () => {
    const { writer, b, ids } = setup([t1, t2, t3]);
    const gate = hangNext(writer.insert);
    const first = b.merge();
    const second = b.merge();
    await vi.waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    gate.open();
    await Promise.all([first, second]);
    expect(writer.insert).toHaveBeenCalledTimes(1);
    expect(ids()).toHaveLength(1);
  });

  it('合并没完成时点“关闭”：合并完成后旧批不再写回提示条（新的一条存成了，原来的照样撤掉，库里不重）', async () => {
    const { writer, b, box, flow } = setup([t1, t2, t3]);
    const gate = hangNext(writer.insert);
    const m = b.merge();
    await vi.waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    b.closeNotice();
    gate.open();
    await m;
    expect(box.getState().batch).toBeNull();
    expect(writer.patch, '原来的三条照样撤').toHaveBeenCalledTimes(3);
    expect(flow.go.mock.calls).toEqual([[{ type: 'cleared' }]]);
  });

  it('旧批的撤销还没回来时记了新的一句：新提示条上的操作照常能做，不被旧的锁挡住（复查 N2）', async () => {
    const { writer, b, box } = setup([t1, t2]);
    const gate = hangNext(writer.patch);
    const u = b.undo();
    await vi.waitFor(() => expect(writer.patch).toHaveBeenCalledTimes(1));
    expect(await b.save({ ...PLAN, items: [todo('倒垃圾'), todo('浇花')] } as TypePlan, '倒垃圾，浇花')).toBe('ok');
    const fresh = box.getState().batch?.entries[0]?.ref.id ?? '';
    await b.undoOne(fresh);
    expect(box.getState().batch?.entries.map((e) => e.ref.title)).toEqual(['浇花']);
    gate.open();
    await u;
    expect(box.getState().batch?.entries.map((e) => e.ref.title), '旧批回来不写回').toEqual(['浇花']);
  });

  it('合并没完成时又按了一次“＋”（fresh）：合并完成后不写回', async () => {
    const { writer, b, box } = setup([t1, t2, t3]);
    const gate = hangNext(writer.insert);
    const m = b.merge();
    await vi.waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    b.fresh();
    gate.open();
    await m;
    expect(box.getState().batch).toBeNull();
  });

  it('合并没完成时点“全部撤销”：不理（锁着），合并完成后是合并的那一条', async () => {
    const { writer, b, ids, flow } = setup([t1, t2, t3]);
    const gate = hangNext(writer.insert);
    const m = b.merge();
    await vi.waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    await b.undo();
    gate.open();
    await m;
    expect(writer.patch, '只有合并撤原来的三条').toHaveBeenCalledTimes(3);
    expect(ids()).toHaveLength(1);
    expect(ids()).not.toContain('t1');
    expect(flow.go).not.toHaveBeenCalled();
  });

  it('全部撤销还没回来时记了新的一句（save）：旧批的结果不写回、不发 reset，新的一批留着', async () => {
    const { writer, b, box, flow } = setup([t1, t2, t3]);
    const gate = hangNext(writer.patch);
    const u = b.undo();
    await vi.waitFor(() => expect(writer.patch).toHaveBeenCalledTimes(1));
    const plan = { ...PLAN, items: [todo('倒垃圾')] } as TypePlan;
    expect(await b.save(plan, '倒垃圾')).toBe('ok');
    gate.open();
    await u;
    expect(box.getState().batch?.entries.map((e) => e.ref.title)).toEqual(['倒垃圾']);
    expect(flow.go).not.toHaveBeenCalled();
  });
});

describe('合并（整块评审第 4 条，主持人代定）', () => {
  it('单条撤成过一条：不再给“合并”，调了也不存', async () => {
    const { writer, b, notice } = setup([t1, t2, t3]);
    expect(notice()?.merge).toBe(true);
    await b.undoOne('t1');
    expect(notice()?.entries).toHaveLength(2);
    expect(notice()?.merge).toBe(false);
    await b.merge();
    expect(writer.insert).not.toHaveBeenCalled();
  });

  it('确认行有一条没选就关掉：不再给“合并”（合并会把没存的那条原话带进去，复查 N4）', async () => {
    const { writer, b, box, notice } = setup([t1, t2]);
    const past = { ...todo('交房租'), due: '2026-10-30', date_basis: 'md', confirm: { past: '2026-10-30', next: '2027-10-30' } } as AiItem;
    box.setState({ ask: [past] });
    expect(notice()?.merge).toBe(true);
    b.dismiss();
    expect(notice()?.merge).toBe(false);
    await b.merge();
    expect(writer.insert).not.toHaveBeenCalled();
  });

  it('“补记”还在存时关掉确认行：存完写回也带着标记，不再给“合并”（复查续第 2 条）', async () => {
    const { writer, b, box, notice } = setup([t1, t2]);
    const past = { ...todo('交房租'), due: '2026-10-30', date_basis: 'md', confirm: { past: '2026-10-30', next: '2027-10-30' } } as AiItem;
    const later = { ...past, title: '交水费' } as AiItem;
    box.setState({ ask: [past, later] });
    const gate = hangNext(writer.insert);
    const c = b.choose('past');
    await vi.waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    b.dismiss();
    gate.open();
    await c;
    expect(notice()?.entries).toHaveLength(3);
    expect(notice()?.merge).toBe(false);
  });

  it('合并成了、有撤不掉的：之后再撤合并条失败，“请到列表里删除”那句还在（复查 N3）', async () => {
    const { b, keys, patchFail, ids } = setup([t1, t2]);
    patchFail.add('t1');
    await b.merge();
    expect(keys()).toContain('plus.notice.mergeLeft');
    patchFail.add(ids()[0] ?? '');
    await b.undo();
    expect(keys()).toContain('plus.notice.mergeLeft');
    expect(keys()).toContain('plus.notice.undoFailed');
  });

  it('合并后的新提示条用新的 plan：不带原来的重复、安排、没有的日子、额度提示', async () => {
    const plan = { ...PLAN, status: 'quota_out', hints: { recur: true, arrange: true, bad_day: { month: 2, day: 30 } }, quotaLeft: 0, aiReason: 'quota' } as TypePlan;
    const { b, box, keys } = setup([t1, t2], plan);
    box.setState({ quotaDue: true });
    expect(keys()).toEqual(expect.arrayContaining(['plus.notice.recur', 'plus.notice.arrange', 'plus.notice.badDay']));
    await b.merge();
    expect(box.getState().batch?.plan).toMatchObject({ status: 'saved', hints: { recur: false, arrange: false, bad_day: null }, quotaLeft: null, aiReason: null });
    expect(keys()).toEqual(['plus.notice.saved']);
  });
});

describe('额度提示在存成那一刻定（整块评审第 12 条）', () => {
  const QUOTA = { ...PLAN, status: 'quota_out', items: [todo('倒垃圾')] } as TypePlan;

  it('额度用完的一句存成：当场记下这次要提醒（不等 land），记过一笔今天不再提醒', async () => {
    const { b, box, flow, keys } = setup([]);
    box.setState({ batch: null });
    expect(await b.save(QUOTA, '倒垃圾')).toBe('ok');
    expect(box.getState().quotaDue).toBe(true);
    expect(keys()[0]).toBe('plus.notice.quota');
    expect(flow.done, 'save 本身不收尾').not.toHaveBeenCalled();
    expect(localStorage.getItem(QUOTA_NOTICE_KEY), '记了一笔').not.toBeNull();
  });

  it('全是要问的（这一刻一条没存）：确认行选完第一条存成时才定；确认行没选就关掉不调 done', async () => {
    const past = { ...todo('交房租'), due: '2026-10-30', date_basis: 'md', confirm: { past: '2026-10-30', next: '2027-10-30' } } as AiItem;
    const { b, box, flow } = setup([]);
    box.setState({ batch: null });
    expect(await b.save({ ...QUOTA, items: [past] }, '10 月 30 号交房租')).toBe('ask');
    expect(box.getState().quotaDue).toBe(false);
    expect(localStorage.getItem(QUOTA_NOTICE_KEY), '还没存成：不记').toBeNull();
    await b.choose('past');
    expect(box.getState().quotaDue).toBe(true);
    expect(flow.done).toHaveBeenCalledTimes(1);
    b.dismiss();
    expect(flow.done).toHaveBeenCalledTimes(1);
  });
});

describe('确认行连点（第二轮复查续第 2 条）', () => {
  it('“补记”连点两下：第一下还在存时第二下不算，只存一条', async () => {
    const { writer, b, box, flow } = setup();
    const past = { ...todo('交房租'), due: '2026-10-30', date_basis: 'md', confirm: { past: '2026-10-30', next: '2027-10-30' } } as AiItem;
    box.setState({ ask: [past] });
    const gate = hangNext(writer.insert);
    const first = b.choose('past');
    const second = b.choose('past');
    await vi.waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    gate.open();
    await Promise.all([first, second]);
    expect(writer.insert).toHaveBeenCalledTimes(1);
    expect(flow.go).toHaveBeenCalledTimes(1);
  });
});

describe('AI 后台整理换掉先存的（R-456）', () => {
  const ai = (items: AiItem[]): TypePlan => ({ ...PLAN, origin: 'ai', items });
  it('sameItems：条数、类型、标题（去掉空白和标点）、日子、截止、时刻、时长都比', () => {
    expect(sameItems([todo('买牛奶')], [todo('买 牛奶。')]), '只差空白和标点：算一样').toBe(true);
    expect(sameItems([todo('买牛奶')], [todo('买点牛奶')]), '标题字不一样：不算一样').toBe(false);
    expect(sameItems([todo('买牛奶')], [todo('买牛奶'), todo('开会')])).toBe(false);
    expect(sameItems([todo('开会')], [{ ...todo('开会'), kind: 'event', date: '2026-11-03', time: '15:00' } as AiItem])).toBe(false);
  });

  it('新的没存上：先存的原样留着（不撤），返回 not_saved', async () => {
    const { writer, b, ids } = setup([t1]);
    const m = b.mark();
    if (!m) throw new Error('没有这一批');
    writer.insert.mockResolvedValue(FAIL);
    expect(await b.replace(m, ai([todo('买牛奶'), todo('开会')]), '买牛奶开会')).toBe('not_saved');
    expect(writer.patch).not.toHaveBeenCalled();
    expect(ids()).toEqual(['t1']);
  });

  it('点过“修改”（touch）：不换；AI 的结果里有要问的过去月日：不换', async () => {
    const { writer, b } = setup([t1]);
    const m = b.mark();
    if (!m) throw new Error('没有这一批');
    const confirm = { ...todo('交房租'), confirm: { past: '2026-10-30', next: '2027-10-30' } } as AiItem;
    expect(await b.replace(m, ai([confirm]), '交房租')).toBe('skip_confirm');
    b.touch();
    expect(await b.replace(m, ai([todo('买牛奶'), todo('开会')]), '买牛奶开会')).toBe('skip_touched');
    expect(writer.insert).not.toHaveBeenCalled();
  });

  it('标题不一样（识别错字）也换：先存的“买流奶”换成 AI 的“买牛奶”', async () => {
    const { b, ids } = setup([{ ref: { table: 'todos', id: 't1', title: '买流奶' }, item: todo('买流奶') }]);
    const m = b.mark();
    if (!m) throw new Error('没有这一批');
    expect(await b.replace(m, ai([todo('买牛奶')]), '买牛奶')).toBe('replaced');
    expect(ids()).not.toContain('t1');
  });

  it('在别处改过、勾完成、删掉（按 id 读回和先存时不一样）：不换（skip_touched）', async () => {
    for (const now of ['v1', null]) {
      const { writer, b, rows } = setup([t1]);
      const m = b.mark();
      if (!m) throw new Error('没有这一批');
      rows.set('t1', now);
      expect(await b.replace(m, ai([todo('买牛奶'), todo('开会')]), '买牛奶开会')).toBe('skip_touched');
      expect(writer.insert).not.toHaveBeenCalled();
    }
  });

  it('换的那一下提示条 busy（按钮禁用）；提示条已经关掉的换完不再弹出来', async () => {
    const { writer, b, notice, box } = setup([t1]);
    const m = b.mark();
    if (!m) throw new Error('没有这一批');
    const gate = hangNext(writer.insert);
    const run = b.replace(m, ai([todo('买牛奶'), todo('开会')]), '买牛奶开会');
    await vi.waitFor(() => expect(notice()?.busy).toBe(true));
    gate.open();
    expect(await run).toBe('replaced');
    expect(notice()?.busy).toBe(false);
    const m2 = b.mark();
    if (!m2) throw new Error('没有这一批');
    box.setState({ batch: null }); // 提示条关了（点 × 或 8 秒到了）
    expect(await b.replace(m2, ai([todo('买牛奶')]), '买牛奶')).toBe('replaced');
    expect(box.getState().batch, '关掉了的不再弹出来').toBeNull();
  });

  it('换成了：提示条是 AI 那一批，带“AI 已整理”；原来的撤不掉的指路句照合并的规矩', async () => {
    const { b, keys, notice, patchFail } = setup([t1]);
    const m = b.mark();
    if (!m) throw new Error('没有这一批');
    patchFail.add('t1');
    expect(await b.replace(m, ai([todo('买牛奶'), todo('开会')]), '买牛奶开会')).toBe('replaced');
    expect(notice()?.entries.map((e) => e.ref.title)).toEqual(['买牛奶', '开会']);
    expect(keys()).toEqual(['plus.notice.savedN', 'plus.notice.aiTidied', 'plus.notice.mergeLeft']);
  });
});
