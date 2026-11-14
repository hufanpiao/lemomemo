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

  it('隐藏沙箱卸下又挂上（评审 2）：新窗口回 ready 之前先排着，不发给旧窗口、不丢', async () => {
    const a = frame();
    const b = frame();
    let cur: Window | null = a.win;
    const c = createPrepClient(() => cur, { encode: async () => null, timeoutMs: 1000, newId: () => 'n1' });
    c.onMessage(msg(a.win, { t: 'ready' }));
    cur = null;   // 窗口拉窄：沙箱卸下
    const p = c.extract(new Uint8Array([1]), 'pdf');
    cur = b.win;   // 再拉宽：挂上新的
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([]);
    c.onMessage(msg(b.win, { t: 'ready' }));
    expect(b.sent).toHaveLength(1);
    c.onMessage(msg(b.win, { t: 'prep', id: 'n1', pages: 2, text: 'x', thumb: null }));
    expect((await p)?.pages).toBe(2);
  });

  it('已经发给旧窗口的请求：新窗口 ready 时立刻当没有，不空等超时', async () => {
    const a = frame();
    const b = frame();
    let cur: Window = a.win;
    const c = createPrepClient(() => cur, { encode: async () => null, timeoutMs: 60_000, newId: () => 'o1' });
    c.onMessage(msg(a.win, { t: 'ready' }));
    const p = c.extract(new Uint8Array([1]), 'pdf');
    expect(a.sent).toHaveLength(1);
    cur = b.win;
    c.onMessage(msg(b.win, { t: 'ready' }));
    expect(await p).toBeNull();
    expect(b.sent).toEqual([]);
  });
});
