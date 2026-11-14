// 加附件时抽预览材料（data/prep-client.ts）：ready 前排队、只认这个 iframe 的回执、失败和超时当没有、缩略图转 webp
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPrepClient } from '../data/prep-client.ts';

function frame() {
  const sent: unknown[] = [];
  const win = { postMessage: vi.fn((m: unknown) => sent.push(m)) } as unknown as Window;
  return { win, sent };
}
const msg = (source: unknown, data: unknown) => ({ source, data }) as MessageEvent;

afterEach(() => vi.useRealTimers());

describe('createPrepClient', () => {
  it('ready 之前排着、ready 后发；回执给页数、文字、webp 缩略图；字节是复制的', async () => {
    const { win, sent } = frame();
    const encode = vi.fn(async () => new Blob(['webp'], { type: 'image/webp' }));
    let n = 0;
    const c = createPrepClient(() => win, { encode, timeoutMs: 1000, newId: () => `id${++n}` });
    const bytes = new Uint8Array([1, 2, 3]);
    const p = c.extract(bytes, 'pdf');
    expect(sent).toEqual([]);
    c.onMessage(msg(win, { t: 'ready' }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: 'prep', id: 'id1', way: 'pdf' });
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    c.onMessage(msg({}, { t: 'prep', id: 'id1', pages: 9, text: 'x', thumb: null }));   // 别的来源不认
    c.onMessage(msg(win, { t: 'prep', id: 'id1', pages: 4, text: '你好', thumb: new ArrayBuffer(4) }));
    const r = await p;
    expect(r?.pages).toBe(4);
    expect(r?.text).toBe('你好');
    expect(r?.thumb?.type).toBe('image/webp');
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it('只存不预览的格式不问沙箱；沙箱报错、超时都回 null；空文字记 null', async () => {
    vi.useFakeTimers();
    const { win, sent } = frame();
    const c = createPrepClient(() => win, { encode: async () => null, timeoutMs: 1000, newId: (() => { let i = 0; return () => `k${++i}`; })() });
    c.onMessage(msg(win, { t: 'ready' }));
    expect(await c.extract(new Uint8Array([1]), 'docm')).toBeNull();
    expect(sent).toEqual([]);
    const bad = c.extract(new Uint8Array([1]), 'docx');
    c.onMessage(msg(win, { t: 'prep', id: 'k1', error: 'render' }));
    expect(await bad).toBeNull();
    const slow = c.extract(new Uint8Array([1]), 'xlsx');
    await vi.advanceTimersByTimeAsync(1001);
    expect(await slow).toBeNull();
    const empty = c.extract(new Uint8Array([1]), 'docx');
    c.onMessage(msg(win, { t: 'prep', id: 'k3', pages: null, text: '', thumb: null }));
    expect(await empty).toEqual({ pages: null, text: null, thumb: null });
  });
});
