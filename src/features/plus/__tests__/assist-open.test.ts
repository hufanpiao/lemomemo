// 判成别的意图交给结果层（hooks/assist-open.ts；B4b-3 独立评审第 1、3 条）：“改成记下”存好才清草稿，没存上、正在存时关掉结果层也不清；
// 日历页选中的那天跟着“改成记下”走；控制器经 setAssistRecorder 交过来，没交过来等一会儿算没存上。结果层（smart-search）、控制器、草稿都用替身
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistAsk } from '../../../../shared/logic/parse/assist.ts';

const fx = vi.hoisted(() => ({ open: vi.fn(), record: vi.fn(), write: vi.fn(), clear: vi.fn() }));
vi.mock('../../smart-search/index.ts', () => ({ loadFindOpen: async () => ({ openAssist: fx.open }) }));
vi.mock('../data/type-draft.ts', () => ({ writeAssistDraft: (...a: unknown[]) => fx.write(...a), clearAssistDraft: async () => fx.clear() }));
const { RECORDER_WAIT_MS, resetAssistRecorder, setAssistRecorder, setTypeOpener, toAssist } = await import('../hooks/assist-open.ts');

const ASK: AssistAsk = { intent: 'search', query: { text: '发票', range: null, kinds: ['event', 'todo', 'note'], done: 'any' } };
type Req = { record: (() => Promise<boolean>) | null; edit: (() => void) | null; onClose: (() => void) | null };
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};
async function open(from: 'plus' | 'voice' = 'plus'): Promise<Req> {
  toAssist({ ask: ASK, raw: '帮我找发票', aiUsed: 0, from, day: '2026-11-20' });
  await flush();
  return fx.open.mock.calls.at(-1)?.[0] as Req;
}

beforeEach(() => {
  for (const f of Object.values(fx)) f.mockReset();
  fx.write.mockResolvedValue(undefined);
  resetAssistRecorder();
  setAssistRecorder((...a) => fx.record(...a));
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('toAssist', () => {
  it('写 assist 草稿（打字条来的照写、录音来的不盖用户的草稿），带上选中的那天', async () => {
    await open('plus');
    expect(fx.write).toHaveBeenCalledWith({ text: '帮我找发票', day: '2026-11-20' }, expect.any(Number), true);
    await open('voice');
    expect(fx.write).toHaveBeenLastCalledWith({ text: '帮我找发票', day: '2026-11-20' }, expect.any(Number), false);
  });

  it('没点“改成记下”就关：清草稿', async () => {
    const r = await open();
    r.onClose?.();
    await flush();
    expect(fx.clear).toHaveBeenCalledTimes(1);
  });

  it('“改”：原话写回草稿（录音来的也盖上）、写好再打开打字条；随后关结果层不清草稿', async () => {
    const opener = vi.fn();
    setTypeOpener(opener);
    const r = await open('voice');
    fx.write.mockClear();
    r.edit?.();
    r.onClose?.();
    expect(opener).not.toHaveBeenCalled();
    await flush();
    expect(fx.write).toHaveBeenCalledWith({ text: '帮我找发票', day: '2026-11-20' }, expect.any(Number), true);
    expect(opener).toHaveBeenCalledTimes(1);
    expect(fx.clear).not.toHaveBeenCalled();
    setTypeOpener(null);
  });

  it('打字条还没登记：“改”只写草稿，不报错；没有原话的不给“改”', async () => {
    setTypeOpener(null);
    const r = await open();
    expect(() => r.edit?.()).not.toThrow();
    toAssist({ ask: ASK, raw: '  ', aiUsed: 0, from: 'plus', day: null });
    await flush();
    expect((fx.open.mock.calls.at(-1)?.[0] as Req).edit).toBeNull();
  });

  it('“改成记下”存好了：记到选中那天、清草稿；关结果层不再清第二次', async () => {
    fx.record.mockResolvedValue('saved');
    const r = await open();
    expect(await r.record?.()).toBe(true);
    expect(fx.record).toHaveBeenCalledWith('帮我找发票', 'assist', 'local', '2026-11-20');
    r.onClose?.();
    await flush();
    expect(fx.clear).toHaveBeenCalledTimes(1);
  });

  it('“改成记下”没存上（控制器正忙、写库失败）：草稿留着，关结果层也不清', async () => {
    fx.record.mockResolvedValue('busy');
    const r = await open();
    const p = r.record?.();
    r.onClose?.();
    expect(await p).toBe(false);
    await flush();
    expect(fx.clear).not.toHaveBeenCalled();
  });

  it('录音那一块一直没挂上（控制器没交过来）：等 RECORDER_WAIT_MS 算没存上，草稿留着', async () => {
    resetAssistRecorder();
    vi.useFakeTimers();
    try {
      const r = await open();
      const p = r.record?.();
      await vi.advanceTimersByTimeAsync(RECORDER_WAIT_MS);
      expect(await p).toBe(false);
      expect(fx.record).not.toHaveBeenCalled();
      expect(fx.clear).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('控制器晚一点才交过来（录音那一块正在加载）：交上来就记', async () => {
    resetAssistRecorder();
    fx.record.mockResolvedValue('saved');
    const r = await open();
    const p = r.record?.();
    setAssistRecorder((...a) => fx.record(...a));
    expect(await p).toBe(true);
    expect(fx.record).toHaveBeenCalledWith('帮我找发票', 'assist', 'local', '2026-11-20');
  });
});
