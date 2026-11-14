// 判成别的意图交给结果层（hooks/assist-open.ts；B4b-3 独立评审第 1、3 条）：“改成记下”存好才清草稿，没存上、正在存时关掉结果层也不清；
// 日历页选中的那天跟着“改成记下”走。结果层（smart-search）、录音控制器、草稿都用替身
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistAsk } from '../../../../shared/logic/parse/assist.ts';

const fx = vi.hoisted(() => ({ open: vi.fn(), record: vi.fn(), write: vi.fn(), clear: vi.fn() }));
vi.mock('../../smart-search/index.ts', () => ({ loadFindOpen: async () => ({ openAssist: fx.open }) }));
vi.mock('../hooks/voice-main.ts', () => ({ mainVoice: { record: (...a: unknown[]) => fx.record(...a) } }));
vi.mock('../data/type-draft.ts', () => ({ writeAssistDraft: (...a: unknown[]) => fx.write(...a), clearAssistDraft: async () => fx.clear() }));
const { toAssist } = await import('../hooks/assist-open.ts');

const ASK: AssistAsk = { intent: 'search', query: { text: '发票', range: null, kinds: ['event', 'todo', 'note'], done: 'any' } };
type Req = { record: (() => Promise<boolean>) | null; onClose: (() => void) | null };
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
});
