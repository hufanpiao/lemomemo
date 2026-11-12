// 按住“＋”录音的整条流程（ui/RecordHost.tsx + hooks/useVoice.ts；B3 FA-3）。录音器、手机识别用桩（platform 那两个文件另有单测），
// ai-voice 和写入用桩：按住 350 ms 开录、录着时压住提醒横幅、松手上传并记下（source = voice）、录满自动结束、离线直接提示、
// 麦克风没问过先出说明卡、AI 没回应可以重试（同一段录音）、不认识的 intent 用转写走本机规则、10 分钟两次网络失败改用手机自带识别
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { collection } from '../../../core/store.ts';
import type { WriteResult } from '../../../core/write.ts';
import { setConsentStale } from '../../../kit/state/consent-fresh.ts';
import { remindQueue } from '../../../kit/state/remind-queue.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { MIC_PERM_KEY, rememberMicResult } from '../../../platform/perm-mic.ts';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import type * as Session from '../../../platform/session.ts';
import type { Writer } from '../data/capture-save.ts';
import type * as Quota from '../data/quota.ts';
import type * as VoiceFlow from '../data/voice-flow.ts';
import { hold, type HoldPointer } from '../data/hold-input.ts';
import { HOLD_MS } from '../data/record-logic.ts';
import { resetVoiceNetForTest } from '../data/voice-session.ts';
import { RecordHost } from '../ui/RecordHost.tsx';

const SID = 'sid-v';
vi.mock('../../../platform/session.ts', async (orig) => ({ ...(await orig<typeof Session>()), readSessionId: () => SID }));

const fx = vi.hoisted(() => ({
  starts: 0,
  autoStop: null as null | (() => void),
  stops: 0,
  speech: [] as { lang: string; end: (r: { ok: true; text: string }) => void; cancelled: boolean }[],
  /** 录音器开录的结果：null 正常开录；给了就按这个失败 */
  startFail: null as null | string,
  /** 录音器 stop() 交出的结局：null 正常交出 2000 字节 */
  stopEnd: null as null | { ok: false; fail: string },
  /** 卡住录音器 stop()（iOS 不发 stop 事件那种）：放开时调 stopOpen */
  stopHang: false,
  stopOpen: null as null | (() => void),
  /** 录音器拿到的取消信号（取消、卸载时要被 abort，录音器才会关轨道） */
  signal: null as null | AbortSignal,
  /** 卡住上传前那一步（toUpload）：放开时调 upOpen */
  upHang: false,
  upOpen: null as null | (() => void),
  /** 今天的 AI 次数用完了没有（本机记的） */
  quotaOut: false,
}));
vi.mock('../../../platform/recorder.ts', () => ({
  recorderSupported: () => true,
  requestMic: async () => 'granted',
  startRecorder: async (o: { onAutoStop?: () => void; signal?: AbortSignal }) => {
    fx.starts += 1;
    fx.autoStop = o.onAutoStop ?? null;
    fx.signal = o.signal ?? null;
    if (fx.startFail !== null) return { ok: false, fail: fx.startFail };
    const end = () => fx.stopEnd ?? { ok: true, auto: false, clip: { blob: new Blob([new Uint8Array(2000)], { type: 'audio/mp4' }), mime: 'audio/mp4', ms: 7000 } };
    return {
      ok: true,
      rec: {
        elapsed: () => 7000,
        level: () => 0.4,
        stop: () => {
          fx.stops += 1;
          if (!fx.stopHang) return Promise.resolve(end());
          return new Promise((ok) => (fx.stopOpen = () => ok(end())));
        },
      },
    };
  },
}));
vi.mock('../data/voice-flow.ts', async (orig) => {
  const m = await orig<typeof VoiceFlow>();
  return {
    ...m,
    toUpload: (c: Parameters<typeof m.toUpload>[0]) => (fx.upHang ? new Promise((ok) => (fx.upOpen = () => ok(c))) : Promise.resolve(c)),
  };
});
vi.mock('../data/quota.ts', async (orig) => ({ ...(await orig<typeof Quota>()), quotaOutToday: async () => fx.quotaOut }));
vi.mock('../../../platform/speech.ts', () => ({
  speechSupported: () => true,
  startSpeech: (lang: string, h: { onStart(): void; onEnd(r: unknown): void }) => {
    const run = { lang, end: (r: unknown) => h.onEnd(r), cancelled: false };
    fx.speech.push(run as never);
    queueMicrotask(() => h.onStart());
    return {
      ok: true,
      session: {
        stop: () => h.onEnd({ ok: true, text: '买牛奶' }),
        cancel: () => {
          run.cancelled = true;
        },
      },
    };
  },
}));

const NOW = msAt('2026-11-02', 12 * 60, 'UTC');
const OK: WriteResult = { ok: true, item: null };
const AI_ON = { id: 'set-ai', key: 'ai.enabled', value: true, deleted_at: null, updated_at: NOW };
const ITEM = {
  kind: 'todo', title: '买猫砂', date: null, time: null, duration_min: null, due: null, important: false,
  project: null, body: null, short: null, date_basis: null, anniv: null, confirm: null,
};
const VOICE_OK = { intent: 'record', confidence: 1, transcript: '买猫砂', quota_left: 41, items: [ITEM] };

let fab: HTMLButtonElement;
/** 这条用例记下的运行日志 */
let log: string[] = [];
const ptr = (y = 800): HoldPointer => ({ button: 0, isPrimary: true, pointerId: 1, clientX: 340, clientY: y, currentTarget: fab });
const sleep = (ms: number) => act(() => new Promise<void>((ok) => setTimeout(ok, ms)));

function setup(o: { call?: (...a: unknown[]) => Promise<unknown>; online?: () => boolean; onType?: () => void } = {}) {
  const writer = { insert: vi.fn<Writer['insert']>(async () => OK), patch: vi.fn<Writer['patch']>(async () => OK) };
  const call = vi.fn(o.call ?? (async () => VOICE_OK));
  const r = render(<RecordHost callVoice={call} writer={writer} online={o.online ?? (() => true)} onType={o.onType} />);
  return { writer, call, unmount: r.unmount };
}

/** 这次录音作废以后：没上传、没写库、没出提示条，录音器收到了取消（会关轨道） */
async function nothingKept(writer: { insert: { mock: { calls: unknown[] } } }, call: { mock: { calls: unknown[] } }): Promise<void> {
  await sleep(30);
  expect(call.mock.calls, '没上传').toHaveLength(0);
  expect(writer.insert.mock.calls, '没写库').toHaveLength(0);
  expect(screen.queryByTestId('voice-notice')).toBeNull();
  expect(screen.queryByTestId('voice-work')).toBeNull();
  expect(fx.signal?.aborted, '录音器收到取消').toBe(true);
}

/** 按住满 350 ms（真计时器：手势用 performance.now 判时长） */
async function holdDown(): Promise<void> {
  act(() => hold.onStart(ptr()));
  await sleep(HOLD_MS + 60);
}
async function release(): Promise<void> {
  await act(async () => {
    hold.onEnd(ptr());
  });
}

beforeEach(() => {
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  uiStore.getState().setLocale('zh-CN');
  collection('settings').upsert([AI_ON]);
  setConsentStale(false, SID);
  rememberMicResult('granted');
  fx.starts = 0;
  fx.stops = 0;
  fx.autoStop = null;
  fx.speech = [];
  fx.startFail = null;
  fx.stopEnd = null;
  fx.stopHang = false;
  fx.stopOpen = null;
  fx.signal = null;
  fx.upHang = false;
  fx.upOpen = null;
  fx.quotaOut = false;
  fab = document.createElement('button');
  fab.setPointerCapture = vi.fn();
  document.body.append(fab);
  log = [];
  (globalThis as Record<string, unknown>)[RL_SLOT] = { q: [], sink: (l: string) => log.push(l) };
  // 失败时把这条用例的运行日志打出来（先看日志定根因）
  onTestFailed(() => console.log(['运行日志：', ...log].join('\n')));
});
afterEach(() => {
  cleanup();
  fab.remove();
  resetVoiceNetForTest();
  collection('settings').clear();
  setConsentStale(false, null);
  localStorage.removeItem(MIC_PERM_KEY);
  remindQueue.setState({ holds: [] });
  delete (globalThis as Record<string, unknown>)[RL_SLOT];
  vi.restoreAllMocks();
});

describe('按住“＋”录音', () => {
  it('按住 350 ms 开录（录着时压住提醒横幅）；松手上传、记下（source = voice），出“已记下 · 撤销”', async () => {
    const { writer, call } = setup();
    await holdDown();
    expect(fx.starts).toBe(1);
    const panel = await screen.findByTestId('rec-panel');
    expect(panel.dataset['status']).toBe('recording');
    expect(screen.getByTestId('rec-cancel-zone').textContent).toBe('↑ 拖到这里取消');
    expect(remindQueue.getState().holds.map((h) => h.reason)).toEqual(['recording']);
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalled());
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[0]).toMatchObject({ mime: 'audio/mp4' });
    expect(writer.insert.mock.calls[0]?.[1]).toMatchObject({ title: '买猫砂', source: 'voice' });
    expect((await screen.findByTestId('type-notice')).textContent).toContain('已记下：买猫砂');
    expect(remindQueue.getState().holds, '松手以后放开').toEqual([]);
  });

  it('不满 350 ms 松开：当点一下，不开录', async () => {
    setup();
    act(() => hold.onStart(ptr()));
    await sleep(100);
    await release();
    await sleep(HOLD_MS);
    expect(fx.starts).toBe(0);
    expect(screen.queryByTestId('rec-panel')).toBeNull();
  });

  it('录满 60 秒（录音器 onAutoStop）：自动结束并上传', async () => {
    const { call } = setup();
    await holdDown();
    await screen.findByTestId('rec-panel');
    await act(async () => {
      fx.autoStop?.();
    });
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(fx.stops).toBe(1);
  });

  it('离线按住：不开录，直接提示“没网，语音用不了，请用键盘”', async () => {
    setup({ online: () => false });
    await holdDown();
    expect(fx.starts).toBe(0);
    const n = await screen.findByTestId('voice-notice');
    expect(n.dataset['note']).toBe('offline');
    expect(n.textContent).toContain('没网，语音用不了，请用键盘');
  });

  it('麦克风还没问过：先出说明卡，不开录', async () => {
    localStorage.removeItem(MIC_PERM_KEY);
    setup();
    await holdDown();
    expect(fx.starts).toBe(0);
    expect(await screen.findByText('按住“＋”说话，要先允许用麦克风')).toBeTruthy();
  });

  it('AI 这次没回应：录音留着，“重试”用同一段录音再发一次', async () => {
    let n = 0;
    const { call, writer } = setup({
      call: async () => {
        n += 1;
        return n === 1 ? { ai_failed: true, reason: 'error' } : VOICE_OK;
      },
    });
    await holdDown();
    await release();
    const note = await screen.findByTestId('voice-notice');
    expect(note.dataset['note']).toBe('ai_failed');
    const first = call.mock.calls[0]?.[0] as { audio: Blob };
    fireEvent.click(screen.getByTestId('voice-retry'));
    await waitFor(() => expect(writer.insert).toHaveBeenCalled());
    expect((call.mock.calls[1]?.[0] as { audio: Blob }).audio).toBe(first.audio);
  });

  it('不认识的 intent 但带着转写：用转写走本机规则记下，原话不丢', async () => {
    const { writer } = setup({ call: async () => ({ ...VOICE_OK, intent: 'summarize' }) });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalled());
    expect(writer.insert.mock.calls[0]?.[1]).toMatchObject({ title: '买猫砂', source: 'voice' });
    expect((await screen.findByTestId('type-notice')).textContent).toContain('已先记下');
  });

  it('10 分钟内网络原因失败 2 次：之后按住改用手机自带识别（面板写“网络慢，这次用手机自带识别”），按界面语言听', async () => {
    const { writer } = setup({
      call: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    for (let i = 0; i < 2; i += 1) {
      await holdDown();
      await release();
      await screen.findByTestId('voice-notice');
      fireEvent.click(screen.getByTestId('voice-notice-close'));
    }
    expect(fx.starts).toBe(2);
    await holdDown();
    expect(fx.starts, '第 3 次不开录音器').toBe(2);
    expect(fx.speech.at(-1)?.lang).toBe('zh-CN');
    expect((await screen.findByTestId('rec-why')).textContent).toBe('网络慢，这次用手机自带识别');
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalled());
    expect(writer.insert.mock.calls[0]?.[1]).toMatchObject({ title: '买牛奶', source: 'voice' });
  });

  it('网络失败的计数跨卸载重挂保留：失败 1 次 → 进设置页又回来（RecordHost 重挂）→ 再失败 1 次，之后照样改用手机自带识别（FA-3 复查第 1 条）', async () => {
    const fail = async (): Promise<never> => {
      throw new TypeError('Failed to fetch');
    };
    const first = setup({ call: fail });
    await holdDown();
    await release();
    await screen.findByTestId('voice-notice');
    first.unmount();
    setup({ call: fail });
    await holdDown();
    await release();
    await screen.findByTestId('voice-notice');
    fireEvent.click(screen.getByTestId('voice-notice-close'));
    expect(fx.starts).toBe(2);
    await holdDown();
    expect(fx.starts, '第 3 次不开录音器').toBe(2);
    expect((await screen.findByTestId('rec-why')).textContent).toBe('网络慢，这次用手机自带识别');
    await release();
  });

  it('上传中点“取消”：回到没按的状态，不记', async () => {
    let hang!: () => void;
    const { writer } = setup({ call: () => new Promise((ok) => (hang = () => ok(VOICE_OK))) });
    await holdDown();
    await release();
    fireEvent.click(await screen.findByTestId('voice-cancel'));
    hang();
    await sleep(20);
    expect(screen.queryByTestId('voice-work')).toBeNull();
    expect(writer.insert).not.toHaveBeenCalled();
  });

  it('运行日志：每次状态转换一行（状态名、路径），结果带字节数和毫秒；不记转写、不记标题', async () => {
    const { writer } = setup();
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalled());
    expect(log).toEqual(
      expect.arrayContaining([
        'voice idle->preparing path=rec',
        'voice preparing->recording path=rec',
        'voice recording->uploading path=rec',
        expect.stringMatching(/^voice result kind=record tries=1 ms=\d+ bytes=2000 timeout_ms=\d+$/),
      ]),
    );
    expect(log.some((l) => l.includes('买猫砂')), '不记说的内容').toBe(false);
  });
});

/** 运行日志里有没有这一行（attempt 代号是数字） */
const logged = (re: RegExp): boolean => log.some((l) => re.test(l));

describe('作废和兜底（FA-3 整块评审第 1、2、14、16、17 条）', () => {
  it('录音器 stop 还没回来时点“取消”（松手后提示条上的取消，没锁定也有退出口）：这次作废，不上传、不写库', async () => {
    fx.stopHang = true;
    const { writer, call } = setup();
    await holdDown();
    await release();
    expect(screen.queryByTestId('rec-panel'), '松手面板就收起').toBeNull();
    fireEvent.click(await screen.findByTestId('voice-cancel'));
    await act(async () => {
      fx.stopOpen?.();
    });
    await nothingKept(writer, call);
    expect(logged(/^voice attempt \d+ drop by=cancel_upload$/)).toBe(true);
    expect(logged(/^voice attempt \d+ stale at=rec_stop$/)).toBe(true);
  });

  it('上传前那一步（toUpload）还没完时点“取消”：不上传、不写库', async () => {
    fx.upHang = true;
    const { writer, call } = setup();
    await holdDown();
    await release();
    fireEvent.click(await screen.findByTestId('voice-cancel'));
    await act(async () => {
      fx.upOpen?.();
    });
    await nothingKept(writer, call);
    expect(logged(/^voice attempt \d+ stale at=to_upload$/)).toBe(true);
  });

  it('录音器 stop 还没回来时卸载（切页、关掉）：不上传、不写库，录音器收到取消', async () => {
    fx.stopHang = true;
    const { writer, call, unmount } = setup();
    await holdDown();
    await release();
    unmount();
    await act(async () => {
      fx.stopOpen?.();
    });
    await sleep(30);
    expect(call).not.toHaveBeenCalled();
    expect(writer.insert).not.toHaveBeenCalled();
    expect(fx.signal?.aborted).toBe(true);
    expect(logged(/^voice attempt \d+ drop by=unmount$/)).toBe(true);
  });

  it('上传中卸载：回来的结果不写库', async () => {
    let hang!: () => void;
    const { writer, call, unmount } = setup({ call: () => new Promise((ok) => (hang = () => ok(VOICE_OK))) });
    await holdDown();
    await release();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      hang();
    });
    await sleep(30);
    expect(writer.insert).not.toHaveBeenCalled();
  });

  it('录音器开不起来、麦克风被拒（{ok:false, fail:"denied"}）：出“麦克风没有打开”卡，不出提示条、不写库', async () => {
    fx.startFail = 'denied';
    const { writer, call } = setup();
    await holdDown();
    expect(await screen.findByText('麦克风没有打开')).toBeTruthy();
    expect(screen.queryByTestId('rec-panel')).toBeNull();
    expect(screen.queryByTestId('voice-notice')).toBeNull();
    expect(call).not.toHaveBeenCalled();
    expect(writer.insert).not.toHaveBeenCalled();
  });

  it('录音器 stop 兜底超时（{ok:false, fail:"stop_timeout"}）：提示“这段没收到，请再说一次”（不是“录音没开起来”），不上传、不写库（FA-3 复查第 2 条）', async () => {
    fx.stopEnd = { ok: false, fail: 'stop_timeout' };
    const { writer, call } = setup();
    await holdDown();
    await release();
    const note = await screen.findByTestId('voice-notice');
    expect(note.dataset['note']).toBe('not_heard');
    expect(note.textContent).toContain('这段没收到，请再说一次');
    expect(call).not.toHaveBeenCalled();
    expect(writer.insert).not.toHaveBeenCalled();
  });

  it('手机自带识别 stop 兜底超时（{ok:false, fail:"timeout"}）：同样提示“这段没收到，请再说一次”，不写库（FA-3 复查第 2 条）', async () => {
    fx.quotaOut = true;
    const { writer } = setup();
    await sleep(10); // 挂上时从本机读额度（异步），读回来再按
    await holdDown();
    expect(fx.speech).toHaveLength(1);
    await act(async () => {
      (fx.speech[0]?.end as (r: unknown) => void)({ ok: false, fail: 'timeout' });
    });
    const note = await screen.findByTestId('voice-notice');
    expect(note.dataset['note']).toBe('not_heard');
    expect(writer.insert).not.toHaveBeenCalled();
  });

  it('“重试”连点两下：只送一次', async () => {
    let n = 0;
    const { call, writer } = setup({
      call: async () => {
        n += 1;
        return n === 1 ? { ai_failed: true, reason: 'error' } : VOICE_OK;
      },
    });
    await holdDown();
    await release();
    await screen.findByTestId('voice-retry');
    const retry = screen.getByTestId('voice-retry');
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(writer.insert).toHaveBeenCalled());
    await sleep(30);
    expect(call).toHaveBeenCalledTimes(2);
    expect(writer.insert).toHaveBeenCalledTimes(1);
  });

  it('“改用打字”：直接打开打字条（不靠点“＋”，那一下会被松手后吞 click 吞掉）', async () => {
    const onType = vi.fn();
    setup({ online: () => false, onType });
    await holdDown();
    await release();
    fireEvent.click(await screen.findByTestId('voice-type'));
    expect(onType).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('voice-notice')).toBeNull();
  });

  it('按下时选好的路，满 350 ms 照用（中间额度刷新成用完，也不改走手机识别：那时已不在手势里）', async () => {
    setup();
    await sleep(10);
    fx.quotaOut = true;
    await holdDown();
    expect(fx.starts, '按下时额度没用完：录音').toBe(1);
    expect(fx.speech, '没在 setTimeout 里开手机识别').toHaveLength(0);
    expect(logged(/^voice hold start .* route=rec$/)).toBe(true);
  });
});
