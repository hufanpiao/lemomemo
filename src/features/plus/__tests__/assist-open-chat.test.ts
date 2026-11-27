// “＋”点“问 AI”交给 AI 助手抽屉（hooks/assist-open.ts 的 toChat；R-492 第 1 段）：先写草稿、打开抽屉带上这一句；
// 有了服务器答复（onAnswered）才清草稿；用完卡的“改成记下”走 recordRaw（存好才清，带上选中的那天）。抽屉、控制器、草稿都用替身
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({ open: vi.fn(), record: vi.fn(), write: vi.fn(), clear: vi.fn() }));
vi.mock('../../ai-chat/index.ts', () => ({ loadChatOpen: async () => ({ openChat: fx.open }) }));
vi.mock('../../smart-search/index.ts', () => ({ loadFindOpen: async () => ({ openAssist: vi.fn() }) }));
vi.mock('../data/type-draft.ts', () => ({ writeAssistDraft: (...a: unknown[]) => fx.write(...a), clearAssistDraft: async () => fx.clear() }));
const { resetAssistRecorder, setAssistRecorder, toChat } = await import('../hooks/assist-open.ts');

type Req = { ask: string; from: string; record: ((raw: string) => Promise<boolean>) | null; onAnswered: (() => void) | null };
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};
async function open(): Promise<Req> {
  toChat({ raw: '这周还有什么没做完？', day: '2026-11-20' });
  await flush();
  return fx.open.mock.calls.at(-1)?.[0] as Req;
}

beforeEach(() => {
  for (const f of Object.values(fx)) f.mockReset();
  fx.write.mockResolvedValue(undefined);
  resetAssistRecorder();
  setAssistRecorder((...a) => fx.record(...a));
});

describe('toChat', () => {
  it('先写草稿（打字条来的照写），再打开抽屉带上这一句', async () => {
    const req = await open();
    expect(fx.write).toHaveBeenCalledWith({ text: '这周还有什么没做完？', day: '2026-11-20' }, expect.any(Number), true);
    expect(req.ask).toBe('这周还有什么没做完？');
    expect(req.from).toBe('plus');
    expect(fx.clear).not.toHaveBeenCalled();
  });

  it('有了服务器答复才清草稿', async () => {
    const req = await open();
    req.onAnswered?.();
    await flush();
    expect(fx.clear).toHaveBeenCalledTimes(1);
  });

  it('用完卡“改成记下”：按本机规则存（带选中的那天），存好才清草稿；没存上不清', async () => {
    const req = await open();
    fx.record.mockResolvedValueOnce('saved');
    await expect(req.record?.('这周还有什么没做完？')).resolves.toBe(true);
    expect(fx.record).toHaveBeenCalledWith('这周还有什么没做完？', 'assist', 'local', '2026-11-20');
    expect(fx.clear).toHaveBeenCalledTimes(1);
    fx.record.mockResolvedValueOnce('failed');
    await expect(req.record?.('x')).resolves.toBe(false);
    expect(fx.clear).toHaveBeenCalledTimes(1);
  });
});
