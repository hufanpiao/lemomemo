// 提示条上一批里有纪念日时的撤销、合并（data/saved-batch.ts；FA-3 复查第 3、4 条）；确认行连点（第二轮复查续第 2 条）
// 纪念日在这里撤不掉（capture-save 的 undoRefs 一律留下）：不算“没撤销成功”，单独一句“纪念日请到纪念日页删除”；
// 全部撤销、逐条撤销时那一条留在提示条上，合并成功后不留（R-405）
import { describe, expect, it, vi } from 'vitest';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import type { WriteResult } from '../../../core/write.ts';
import type { Writer } from '../data/capture-save.ts';
import type { TypePlan } from '../data/type-flow.ts';
import { createBatchBox, createSavedBatch, noticeOf, type Batch } from '../data/saved-batch.ts';

const OK: WriteResult = { ok: true, item: null };
const NOW = Date.UTC(2026, 10, 2, 3);
const todo = (title: string): AiItem => ({
  kind: 'todo', title, date: null, time: null, duration_min: null, due: null, important: false,
  project: null, body: null, short: null, date_basis: null, anniv: null, confirm: null,
}) as AiItem;
const PLAN = { status: 'saved', origin: 'rule', items: [], hints: { recur: false, arrange: false, bad_day: null }, quotaLeft: null, aiReason: null } as unknown as TypePlan;

function batchOf(): Batch {
  return {
    batchId: 'b1',
    raw: '买牛奶，交电费，妈妈生日',
    remind: false,
    plan: PLAN,
    entries: [
      { ref: { table: 'todos', id: 't1', title: '买牛奶' }, item: todo('买牛奶') },
      { ref: { table: 'todos', id: 't2', title: '交电费' }, item: todo('交电费') },
      { ref: { table: 'anniversaries', id: 'a1', title: '妈妈生日' }, item: todo('妈妈生日') },
    ],
  };
}

function setup() {
  const writer = { insert: vi.fn<Writer['insert']>(async () => OK), patch: vi.fn<Writer['patch']>(async () => OK) };
  const box = createBatchBox();
  box.setState({ batch: batchOf() });
  const flow = { go: vi.fn(), done: vi.fn(), fail: vi.fn(), error: vi.fn() };
  const b = createSavedBatch({ box, writer, tag: 'test', env: () => ({ now: NOW, tz: 'Asia/Seoul', day: null }), flow });
  const notice = () => noticeOf(box.getState());
  const keys = (): string[] => notice()?.lines.map((l) => l.key) ?? [];
  return { writer, b, notice, keys, flow, box };
}

describe('一批里有纪念日', () => {
  it('全部撤销：撤掉别的，纪念日留在提示条上、单独一句，不算没撤成；再点一次也一样', async () => {
    const { writer, b, notice, keys, flow } = setup();
    await b.undo();
    expect(flow.go, '没有真正失败的：回到 idle').toHaveBeenCalledWith({ type: 'reset' });
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

describe('确认行连点（第二轮复查续第 2 条）', () => {
  it('“补记”连点两下：第一下还在存时第二下不算，只存一条', async () => {
    const { writer, b, box, flow } = setup();
    const past = { ...todo('交房租'), due: '2026-10-30', date_basis: 'md', confirm: { past: '2026-10-30', next: '2027-10-30' } } as AiItem;
    box.setState({ ask: [past] });
    let open: (() => void) | undefined;
    writer.insert.mockImplementationOnce(() => new Promise<WriteResult>((ok) => (open = () => ok(OK))));
    const first = b.choose('past');
    const second = b.choose('past');
    await vi.waitFor(() => expect(open).toBeDefined());
    open?.();
    await Promise.all([first, second]);
    expect(writer.insert).toHaveBeenCalledTimes(1);
    expect(flow.go).toHaveBeenCalledTimes(1);
  });
});
