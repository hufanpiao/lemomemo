// 对话输入条“＋”选的图（hooks/useChatPics.ts，负责人 11-23 弹窗；独立评审第 4 条）
// • 最多 CHAT_IMAGES_MAX 张，多选的超出部分不收；压不了的不收、回 false
// • attach 带上 webp + base64：settle(true) 才清空、revoke 预览；settle(false) 图留着；发着的时候不能加、不能移、再 attach 不带图
// • allowed 跟着 takes（mine 回的 images）；读到之前是 false
// • encodeForAi 的上限：压好的图 base64 一定放得进 CHAT_IMAGE_B64_MAX
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_IMAGE_B64_MAX, CHAT_IMAGES_MAX } from '../../../../shared/schema/chat.ts';
import { AI_MAX } from '../../../platform/image-encode.ts';
import { b64Of, useChatPics } from '../hooks/useChatPics.ts';

const file = (name: string): File => new File([name], `${name}.jpg`, { type: 'image/jpeg' });
const ok = vi.fn(async (f: Blob) => new Blob([await f.text()], { type: 'image/webp' }));
const yes = async (): Promise<boolean> => true;
const no = async (): Promise<boolean> => false;

beforeEach(() => {
  let n = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:t/${++n}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useChatPics', () => {
  it('最多收 3 张，超出的不压', async () => {
    const { result } = renderHook(() => useChatPics(ok, yes));
    let r = false;
    await act(async () => { r = await result.current.add([file('a'), file('b'), file('c'), file('d')]); });
    expect(r).toBe(true);
    expect(result.current.pics).toHaveLength(CHAT_IMAGES_MAX);
    expect(result.current.room).toBe(false);
    expect(ok).toHaveBeenCalledTimes(CHAT_IMAGES_MAX);
    await act(async () => { await result.current.add([file('e')]); });
    expect(result.current.pics).toHaveLength(CHAT_IMAGES_MAX);
  });

  it('压不了的不收、回 false，其余照收', async () => {
    const enc = vi.fn(async (f: Blob) => ((await f.text()) === 'bad' ? null : new Blob(['x'], { type: 'image/webp' })));
    const { result } = renderHook(() => useChatPics(enc, yes));
    let r = true;
    await act(async () => { r = await result.current.add([file('bad'), file('good')]); });
    expect(r).toBe(false);
    expect(result.current.pics).toHaveLength(1);
    expect(result.current.busy).toBe(false);
  });

  it('attach 带上 webp + base64；settle(true) 才清空、revoke 预览；remove 移一张', async () => {
    const { result } = renderHook(() => useChatPics(ok, yes));
    await act(async () => { await result.current.add([file('hi'), file('yo')]); });
    act(() => result.current.remove(result.current.pics[0]?.id ?? -1));
    expect(result.current.pics).toHaveLength(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:t/1');
    let out: ReturnType<typeof result.current.attach> | null = null;
    act(() => { out = result.current.attach(); });
    expect(out!.images).toEqual([{ mime: 'image/webp', data: btoa('yo') }]);
    expect(result.current.sending).toBe(true);
    expect(result.current.pics).toHaveLength(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:t/2');
    act(() => out!.settle(true));
    expect(result.current.pics).toHaveLength(0);
    expect(result.current.sending).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:t/2');
  });

  it('没成（settle(false)）图留着可以再发；发着的时候不能加、不能移、再 attach 不带图', async () => {
    const { result } = renderHook(() => useChatPics(ok, yes));
    await act(async () => { await result.current.add([file('hi')]); });
    let first: ReturnType<typeof result.current.attach> | null = null;
    act(() => { first = result.current.attach(); });
    expect(result.current.room).toBe(false);
    await act(async () => { await result.current.add([file('more')]); });
    act(() => result.current.remove(result.current.pics[0]?.id ?? -1));
    expect(result.current.pics).toHaveLength(1);
    let second: ReturnType<typeof result.current.attach> | null = null;
    act(() => { second = result.current.attach(); });
    expect(second!.images).toBeUndefined();
    act(() => first!.settle(false));
    expect(result.current.pics).toHaveLength(1);
    expect(result.current.sending).toBe(false);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    let again: ReturnType<typeof result.current.attach> | null = null;
    act(() => { again = result.current.attach(); });
    expect(again!.images).toEqual([{ mime: 'image/webp', data: btoa('hi') }]);
  });

  it('allowed 跟着 takes：读到之前 false，收图的家 true，不收的家 false', async () => {
    const a = renderHook(() => useChatPics(ok, yes));
    expect(a.result.current.allowed).toBe(false);
    await waitFor(() => expect(a.result.current.allowed).toBe(true));
    const b = renderHook(() => useChatPics(ok, no));
    await act(async () => { await Promise.resolve(); });
    expect(b.result.current.allowed).toBe(false);
  });

  it('b64Of 分段拼和 btoa 一致；AI_MAX 的 base64 放得进 CHAT_IMAGE_B64_MAX', async () => {
    const u = new Uint8Array(0x8000 * 2 + 5).map((_, i) => i % 251);
    expect(await b64Of(new Blob([u]))).toBe(btoa(String.fromCharCode(...u)));
    expect(Math.ceil(AI_MAX / 3) * 4).toBeLessThanOrEqual(CHAT_IMAGE_B64_MAX);
  });
});
