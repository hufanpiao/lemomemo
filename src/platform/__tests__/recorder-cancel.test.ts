// 录音平台层（platform/recorder.ts）：开不起来和取消（桩在 recorder-fake.ts）。
// 钉住：拿到流以后任何一步失败或取消都先停录音器、关轨道、清计时器；signal 从调用到交出结果一直有效；授权框开着时取消，权限结果照记
import { describe, expect, it, vi } from 'vitest';
import { lastMicResult } from '../perm-mic.ts';
import { REC_START_WAIT_MS, startRecorder } from '../recorder.ts';
import { allClosed, FakeRecorder, flush, MAX_MS, mic, named, opts, rec0, recorderEnv, recording } from './recorder-fake.ts';

const log = recorderEnv();

describe('开不起来：先关轨道、清计时器再返回', () => {
  it('建录音器抛错、start() 抛错：start_failed', async () => {
    const a = mic();
    FakeRecorder.ctorThrows = named('NotSupportedError');
    expect(await startRecorder(opts())).toEqual({ ok: false, fail: 'start_failed' });
    expect(allClosed(a)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    FakeRecorder.ctorThrows = null;
    FakeRecorder.startThrows = named('InvalidStateError');
    const b = mic();
    expect(await startRecorder(opts())).toEqual({ ok: false, fail: 'start_failed' });
    expect(allClosed(b)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('start 事件之前来了 error 事件：start_failed', async () => {
    const m = mic();
    const p = startRecorder(opts());
    await flush();
    rec0().fireError('NotSupportedError');
    expect(await p).toEqual({ ok: false, fail: 'start_failed' });
    expect(allClosed(m)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('等了 REC_START_WAIT_MS 还没有 start 事件：start_failed，录音器停掉', async () => {
    const m = mic();
    const p = startRecorder(opts());
    await flush();
    await vi.advanceTimersByTimeAsync(REC_START_WAIT_MS - 1);
    expect(allClosed(m)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ ok: false, fail: 'start_failed' });
    expect(rec0().stopCalls).toBe(1);
    expect(allClosed(m)).toBe(true);
    expect(log.lines.at(-1)).toMatch(/^rec fail reason=start_timeout$/);
  });
});

describe('取消（signal 全程有效，只有这一套）', () => {
  it('调用时已经取消：不去要麦克风', async () => {
    const m = mic();
    const ac = new AbortController();
    ac.abort();
    expect(await startRecorder(opts({ signal: ac.signal }))).toEqual({ ok: false, fail: 'cancelled' });
    expect(m.getUserMedia).not.toHaveBeenCalled();
  });

  it('麦克风还没回来就取消：流一回来马上关、不建录音器；权限结果照记', async () => {
    let give: (s: MediaStream) => void = () => undefined;
    const m = mic(new Promise<MediaStream>((r) => (give = r)));
    const ac = new AbortController();
    const p = startRecorder(opts({ signal: ac.signal }));
    await flush();
    ac.abort();
    give(m.stream);
    expect(await p).toEqual({ ok: false, fail: 'cancelled' });
    expect(allClosed(m)).toBe(true);
    expect(FakeRecorder.made).toHaveLength(0);
    expect(lastMicResult()).toBe('granted');
  });

  it('授权框还开着就取消、随后点了拒绝：照样记 denied', async () => {
    let refuse: (e: Error) => void = () => undefined;
    mic(new Promise<MediaStream>((_r, reject) => (refuse = reject)));
    const ac = new AbortController();
    const p = startRecorder(opts({ signal: ac.signal }));
    await flush();
    ac.abort();
    refuse(named('NotAllowedError'));
    expect((await p).ok).toBe(false);
    expect(lastMicResult()).toBe('denied');
  });

  it('start() 之后、start 事件之前取消：停录音器、关轨道', async () => {
    const m = mic();
    const ac = new AbortController();
    const p = startRecorder(opts({ signal: ac.signal }));
    await flush();
    ac.abort();
    expect(await p).toEqual({ ok: false, fail: 'cancelled' });
    expect(rec0().stopCalls).toBe(1);
    expect(allClosed(m)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('已经在录了再取消也算数：停、关轨道，等着的 stop() 得 cancelled；之后不再自动停、不通知', async () => {
    const m = mic();
    const ac = new AbortController();
    const onAutoStop = vi.fn();
    const rec = await recording({ signal: ac.signal, onAutoStop });
    const waiting = rec.stop();
    ac.abort();
    expect(await waiting).toEqual({ ok: false, fail: 'cancelled' });
    expect(await rec.stop()).toEqual({ ok: false, fail: 'cancelled' });
    expect(allClosed(m)).toBe(true);
    await vi.advanceTimersByTimeAsync(MAX_MS);
    expect(rec0().stopCalls).toBe(1);
    expect(onAutoStop).not.toHaveBeenCalled();
  });

  it('录音中（还没人停）取消：录音器停一次、麦克风马上关', async () => {
    const m = mic();
    const ac = new AbortController();
    const rec = await recording({ signal: ac.signal });
    ac.abort();
    expect(rec0().stopCalls).toBe(1);
    expect(allClosed(m)).toBe(true);
    expect(await rec.stop()).toEqual({ ok: false, fail: 'cancelled' });
  });

  it('已经交出结果以后再取消：结果不变，不多记日志', async () => {
    mic();
    const ac = new AbortController();
    const rec = await recording({ signal: ac.signal });
    const end = await rec.stop();
    const n = log.lines.length;
    ac.abort();
    expect(await rec.stop()).toBe(end);
    expect(end.ok).toBe(true);
    expect(log.lines).toHaveLength(n);
  });
});
