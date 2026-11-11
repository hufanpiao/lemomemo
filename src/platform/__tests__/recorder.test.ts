// 录音平台层（platform/recorder.ts）：假的 MediaRecorder、假计时器（桩在 recorder-fake.ts；开不起来、取消在 recorder-cancel.test.ts）。
// 钉住：start 事件到了才算开始、60 秒和字节两条上限、结束时的清理、拿麦克风的归类、运行日志不带内容
import { describe, expect, it, vi } from 'vitest';
import { lastMicResult, MIC_PERM_KEY } from '../perm-mic.ts';
import { recorderSupported, requestMic, startRecorder } from '../recorder.ts';
import { allClosed, FakeRecorder, flush, MAX_BYTES, MAX_MS, mic, named, opts, rec0, recorderEnv, recording } from './recorder-fake.ts';

const log = recorderEnv();

describe('起点：start 事件到了才算开始（句首丢字的根因）', () => {
  it('start() 已调用但 start 事件没到：还不算开始；事件到了才交出录音', async () => {
    const m = mic();
    let settled = false;
    const p = startRecorder(opts()).then((r) => {
      settled = true;
      return r;
    });
    await flush();
    // 和实测判“直传”时同一种录法：只给流、不带选项，start() 不带分片参数
    expect(rec0().ctorArgs).toEqual([m.stream]);
    expect(rec0().startArgs).toEqual([[]]);
    expect(settled).toBe(false);
    rec0().fireStart();
    expect((await p).ok).toBe(true);
  });

  it('时长从 start 事件算，不从调用算', async () => {
    mic();
    let t = 1000;
    const p = startRecorder(opts({ now: () => t }));
    await flush();
    t = 1400;
    rec0().fireStart();
    const r = await p;
    if (!r.ok) throw new Error(r.fail);
    t = 2400;
    expect(r.rec.elapsed()).toBe(1000);
    t = 3400;
    const end = await r.rec.stop();
    expect(end).toMatchObject({ ok: true, clip: { ms: 2000 } });
    expect(r.rec.elapsed()).toBe(2000);
  });

  it('60 秒从 start 事件起算：到点录音器自己停、通知一次，结果带 auto', async () => {
    const m = mic();
    const onAutoStop = vi.fn();
    const p = startRecorder(opts({ onAutoStop }));
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    rec0().fireStart();
    const r = await p;
    if (!r.ok) throw new Error(r.fail);
    await vi.advanceTimersByTimeAsync(MAX_MS - 1);
    expect(rec0().stopCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(rec0().stopCalls).toBe(1);
    expect(onAutoStop).toHaveBeenCalledTimes(1);
    expect(await r.rec.stop()).toMatchObject({ ok: true, auto: true });
    expect(rec0().stopCalls).toBe(1);
    expect(allClosed(m)).toBe(true);
  });

  it('要了码率才带 audioBitsPerSecond（60 秒会超字节上限时由调用方给）', async () => {
    const m = mic();
    await recording({ bitsPerSecond: 64_000 });
    expect(rec0().ctorArgs).toEqual([m.stream, { audioBitsPerSecond: 64_000 }]);
  });
});

describe('结束', () => {
  it('stop()：各片拼成一段，类型去参数转小写，关轨道；再调一次是同一个结果', async () => {
    const m = mic();
    const onAutoStop = vi.fn();
    const rec = await recording({ onAutoStop });
    rec0().chunks = [new Blob([new Uint8Array(300)]), new Blob([new Uint8Array(45)])];
    const end = await rec.stop();
    if (!end.ok) throw new Error(end.fail);
    expect(end.clip.blob.size).toBe(345);
    expect(end.clip.mime).toBe('audio/mp4');
    expect(end.clip.blob.type).toBe('audio/mp4');
    expect(end.auto).toBe(false);
    expect(allClosed(m)).toBe(true);
    expect(await rec.stop()).toBe(end);
    expect(rec0().stopCalls).toBe(1);
    expect(onAutoStop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('录音器没报类型：取第一片的', async () => {
    mic();
    const rec = await recording();
    rec0().mimeType = '';
    rec0().chunks = [new Blob([new Uint8Array(10)], { type: 'Audio/WebM;codecs=opus' })];
    expect(await rec.stop()).toMatchObject({ ok: true, clip: { mime: 'audio/webm' } });
  });

  it('刚好到字节上限照收；多 1 字节拒绝，不交出录音', async () => {
    mic();
    const a = await recording();
    rec0().chunks = [new Blob([new Uint8Array(MAX_BYTES)])];
    expect(await a.stop()).toMatchObject({ ok: true });

    FakeRecorder.made = [];
    const b = await recording();
    rec0().chunks = [new Blob([new Uint8Array(MAX_BYTES)]), new Blob([new Uint8Array(1)])];
    expect(await b.stop()).toEqual({ ok: false, fail: 'too_large' });
  });

  it('录完 0 字节：empty', async () => {
    mic();
    const rec = await recording();
    rec0().chunks = [];
    expect(await rec.stop()).toEqual({ ok: false, fail: 'empty' });
  });

  it('没人停、录音器自己停了（轨道被系统收走）：通知一次，已录的照样交出', async () => {
    const m = mic();
    const onAutoStop = vi.fn();
    const rec = await recording({ onAutoStop });
    rec0().endNow();
    expect(onAutoStop).toHaveBeenCalledTimes(1);
    const end = await rec.stop();
    expect(end).toMatchObject({ ok: true, auto: true });
    expect(end.ok && end.clip.blob.size).toBe(100);
    expect(rec0().stopCalls).toBe(0);
    expect(allClosed(m)).toBe(true);
  });

  it('录音中出 error 事件：rec_error，关轨道', async () => {
    const m = mic();
    const rec = await recording();
    rec0().fireError();
    expect(await rec.stop()).toEqual({ ok: false, fail: 'rec_error' });
    expect(allClosed(m)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('拿麦克风', () => {
  it('被拒：denied，记下，不建录音器；拿到了记 granted', async () => {
    mic(named('NotAllowedError'));
    expect(await startRecorder(opts())).toEqual({ ok: false, fail: 'denied' });
    expect(lastMicResult()).toBe('denied');
    expect(FakeRecorder.made).toHaveLength(0);

    mic();
    await recording();
    expect(lastMicResult()).toBe('granted');
  });

  it('别的错（没有麦克风）：no_mic，记下的权限不动', async () => {
    mic(named('NotFoundError'));
    expect(await startRecorder(opts())).toEqual({ ok: false, fail: 'no_mic' });
    expect(lastMicResult()).toBe('unknown');
    localStorage.setItem(MIC_PERM_KEY, 'granted');
    expect(await startRecorder(opts())).toEqual({ ok: false, fail: 'no_mic' });
    expect(lastMicResult()).toBe('granted');
  });

  it('没有 MediaRecorder 或没有 mediaDevices：unsupported，不去要麦克风', async () => {
    const m = mic();
    vi.stubGlobal('MediaRecorder', undefined);
    expect(recorderSupported()).toBe(false);
    expect(await startRecorder(opts())).toEqual({ ok: false, fail: 'unsupported' });
    expect(await requestMic()).toBe('unsupported');
    expect(m.getUserMedia).not.toHaveBeenCalled();

    vi.stubGlobal('MediaRecorder', FakeRecorder);
    vi.stubGlobal('navigator', {});
    expect(recorderSupported()).toBe(false);
    expect(await startRecorder(opts())).toEqual({ ok: false, fail: 'unsupported' });
  });
});

describe('只申请麦克风权限（说明卡点“允许麦克风”用）', () => {
  it('允许：马上关轨道、记 granted，不建录音器、不记录音那几行日志', async () => {
    const m = mic();
    expect(await requestMic()).toBe('granted');
    expect(allClosed(m)).toBe(true);
    expect(lastMicResult()).toBe('granted');
    expect(FakeRecorder.made).toHaveLength(0);
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toMatch(/^mic ask result=granted ms=\d+$/);
  });

  it('拒绝：denied，记下', async () => {
    mic(named('NotAllowedError'));
    expect(await requestMic()).toBe('denied');
    expect(lastMicResult()).toBe('denied');
  });

  it('别的错：no_mic，不记', async () => {
    mic(named('NotReadableError'));
    expect(await requestMic()).toBe('no_mic');
    expect(lastMicResult()).toBe('unknown');
  });
});

describe('运行日志：开始、结束、失败各一行，只有约定的键和数字', () => {
  it('开始 + 结束', async () => {
    mic();
    let t = 0;
    const p = startRecorder(opts({ now: () => t }));
    t = 120;
    await flush();
    t = 180;
    rec0().fireStart();
    const r = await p;
    if (!r.ok) throw new Error(r.fail);
    t = 2180;
    await r.rec.stop();
    expect(log.lines).toEqual(['rec start mime=audio/mp4 gum_ms=120 start_ms=60', 'rec end bytes=100 ms=2000 auto=0']);
  });

  it('失败：带原因；有错误类型名时只收字母；超限带字节数和时长', async () => {
    mic(named('NotAllowedError'));
    await startRecorder(opts());
    expect(log.lines).toEqual(['rec fail reason=denied type=NotAllowedError']);

    log.lines.length = 0;
    mic(Object.assign(new Error('x'), { name: 'bad name; 买牛奶' }));
    await startRecorder(opts());
    expect(log.lines).toEqual(['rec fail reason=no_mic']);

    log.lines.length = 0;
    mic();
    const rec = await recording({ maxBytes: 50 });
    await rec.stop();
    expect(log.lines.at(-1)).toBe('rec fail reason=too_large bytes=100 ms=0');
    expect(log.lines).toHaveLength(2);
  });
});
