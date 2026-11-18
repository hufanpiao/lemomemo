// 按住“＋”录音的整条流程（ui/RecordHost.tsx + hooks/useVoice.ts；B3 FA-3）。录音器、手机识别用桩（platform 那两个文件另有单测），
// ai-voice 和写入用桩：按住 350 ms 开录、录着时压住提醒横幅、松手上传并记下（source = voice）、录满自动结束、离线直接提示、
// 麦克风没问过先出说明卡、AI 没回应可以重试（同一段录音）、不认识的 intent 用转写走本机规则、10 分钟两次网络失败改用手机自带识别；
// 录音这一路边说边出字（R-456）：先按本机规则存、AI 后台整理换掉或不换、识别没出字 / 报错照原来、录音器没录成把字交给 ai-parse
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
import type * as Boot from '../../../core/boot.ts';
import type { Writer } from '../data/capture-save.ts';
import type * as Quota from '../data/quota.ts';
import type { CallAi } from '../data/type-flow.ts';
import type * as VoiceFlow from '../data/voice-flow.ts';
import type { HoldPointer } from '../data/hold-input.ts';
import { hold } from '../hooks/voice-sink.ts';
import { HOLD_MS } from '../data/record-logic.ts';
import { LIVE_LATE_MS } from '../data/voice-live.ts';
import { createVoiceSession, type VoiceSession } from '../data/voice-session.ts';
import { RecordHost } from '../ui/RecordHost.tsx';

const SID = 'sid-v';
vi.mock('../../../platform/session.ts', async (orig) => ({ ...(await orig<typeof Session>()), readSessionId: () => SID }));

const fx = vi.hoisted(() => ({
  starts: 0,
  autoStop: null as null | (() => void),
  stops: 0,
  speech: [] as { lang: string; end: (r: unknown) => void; text: (t: string) => void; live: boolean; cancelled: boolean }[],
  /** 录音这一路边说边出字的识别（要中途文字的那个）停下时交出的字：默认空串 = 没认出字，照原来上传等 AI（R-456） */
  liveSay: '',
  /** 给了就让录音这一路的识别按这个失败（stop 时） */
  liveFail: null as null | string,
  /** 录音这一路的识别不发 start（还没开始收音） */
  liveNoStart: false,
  /** 录音这一路的识别再开就开不起来（重开失败） */
  liveRefuse: false,
  /** 录音这一路的识别 stop 以后先不交结局（测试里调 run.end） */
  liveHang: false,
  /** 录音器开录的结果：null 正常开录；给了就按这个失败 */
  startFail: null as null | string,
  /** 录音器 stop() 交出的结局：null 正常交出 2000 字节 */
  stopEnd: null as null | { ok: false; fail: string },
  /** 卡住录音器 stop()（iOS 不发 stop 事件那种）：放开时调 stopOpen */
  stopHang: false,
  stopOpen: null as null | (() => void),
  /** 卡住录音器开录（iOS 系统麦克风框弹着、还没点“允许”）：放开时调 startOpen */
  startHang: false,
  startOpen: null as null | (() => void),
  /** 录音器拿到的取消信号（取消、卸载时要被 abort，录音器才会关轨道） */
  signal: null as null | AbortSignal,
  /** 卡住上传前那一步（toUpload）：放开时调 upOpen */
  upHang: false,
  upOpen: null as null | (() => void),
  /** 今天的 AI 次数用完了没有（本机记的） */
  quotaOut: false,
  /** 升级中心 busy 现在占着的（holdBusy 的 reason） */
  busy: [] as string[],
}));
// 升级中心：busy 占着时不自动重新载入（只假这一样，别的 getBoot()?.cache 照样是 null）
vi.mock('../../../core/boot.ts', async (orig) => ({
  ...(await orig<typeof Boot>()),
  getBoot: () => ({
    upgrade: {
      holdBusy: (r: string) => {
        fx.busy.push(r);
        return () => void fx.busy.splice(fx.busy.indexOf(r), 1);
      },
    },
  }),
}));
vi.mock('../../../platform/recorder.ts', () => ({
  recorderSupported: () => true,
  requestMic: async () => 'granted',
  startRecorder: async (o: { onAutoStop?: () => void; signal?: AbortSignal }) => {
    fx.starts += 1;
    fx.autoStop = o.onAutoStop ?? null;
    fx.signal = o.signal ?? null;
    if (fx.startHang) await new Promise<void>((ok) => (fx.startOpen = ok));
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
  // 诊断开关照真的读本机（关掉的那条用例设 lemo-live-speech-off）
  liveSpeechOn: () => localStorage.getItem('lemo-live-speech-off') !== '1',
  startSpeech: (lang: string, h: { onStart(): void; onEnd(r: unknown): void; onText?(t: string): void }) => {
    // 要中途文字的是录音这一路边说边出字的那个（R-456），不要的是手机自带识别那一路
    const live = h.onText !== undefined;
    if (live && fx.liveRefuse) return { ok: false, fail: 'error' };
    const run = { lang, end: (r: unknown) => h.onEnd(r), text: (t: string) => h.onText?.(t), live, cancelled: false };
    fx.speech.push(run);
    if (!(live && fx.liveNoStart)) queueMicrotask(() => h.onStart());
    return {
      ok: true,
      session: {
        stop: () => {
          if (!live) return h.onEnd({ ok: true, text: '买牛奶' });
          if (fx.liveHang) return;
          h.onEnd(fx.liveFail === null ? { ok: true, text: fx.liveSay } : { ok: false, fail: fx.liveFail });
        },
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

/** 这条用例的控制器（用完 dispose） */
let live: VoiceSession | null = null;

/** 挂一份 RecordHost；session 给了就重挂那一份（切页回来），不给就新建一份带桩的控制器 */
function setup(o: { call?: (...a: unknown[]) => Promise<unknown>; callAi?: CallAi; online?: () => boolean; onType?: () => void; session?: VoiceSession } = {}) {
  const writer = { insert: vi.fn<Writer['insert']>(async () => OK), patch: vi.fn<Writer['patch']>(async () => OK) };
  const call = vi.fn(o.call ?? (async () => VOICE_OK));
  const session = o.session ?? createVoiceSession({ callVoice: call, callAi: o.callAi, writer, online: o.online ?? (() => true) });
  live = session;
  const r = render(<RecordHost session={session} onType={o.onType} />);
  return { writer, call, session, unmount: r.unmount };
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
  fx.liveSay = '';
  fx.liveFail = null;
  fx.liveNoStart = false;
  fx.liveRefuse = false;
  fx.liveHang = false;
  fx.startFail = null;
  fx.stopEnd = null;
  fx.stopHang = false;
  fx.stopOpen = null;
  fx.startHang = false;
  fx.startOpen = null;
  fx.signal = null;
  fx.upHang = false;
  fx.upOpen = null;
  fx.quotaOut = false;
  fx.busy = [];
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
  live?.dispose();
  live = null;
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
    setup({ session: first.session });
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

  // 切页（RecordHost 卸载）算取消（负责人 11-13 弹窗定，待定 24、R-404；原来第二轮第 11 条“当松手处理、照常传完存下”作废）：
  // 录着、上传中、还没开始写库的整理都中止、不存；已经在写库的照常存完。控制器还是模块级的那一份（回来提示条、确认行还在）
  it('录音器 stop 还没回来时切页：算取消，不上传、不写库，录音器收到取消', async () => {
    fx.stopHang = true;
    const { writer, call, unmount } = setup();
    await holdDown();
    await release();
    unmount();
    await act(async () => {
      fx.stopOpen?.();
    });
    await nothingKept(writer, call);
    expect(logged(/^voice host detach status=uploading cancel=1$/)).toBe(true);
    expect(logged(/^voice attempt \d+ drop by=page_leave$/)).toBe(true);
  });

  it('上传中切页：中止上传、不写库；回到有“＋”的页（重挂）不出“已记下”', async () => {
    let hang!: () => void;
    const { writer, call, session, unmount } = setup({ call: () => new Promise((ok) => (hang = () => ok(VOICE_OK))) });
    await holdDown();
    await release();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      hang();
    });
    await sleep(30);
    expect(writer.insert, '没写库').not.toHaveBeenCalled();
    expect(logged(/^voice attempt \d+ stale at=send$/)).toBe(true);
    setup({ session });
    await sleep(10);
    expect(screen.queryByTestId('type-notice')).toBeNull();
    expect(screen.queryByTestId('voice-notice')).toBeNull();
  });

  it('上传中切页：升级中心的 busy 当场放开（这一次已经取消，没有要保住的）', async () => {
    let hang!: () => void;
    const { call, unmount } = setup({ call: () => new Promise((ok) => (hang = () => ok(VOICE_OK))) });
    await holdDown();
    expect(fx.busy, '录着').toEqual(['recording']);
    await release();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    unmount();
    expect(fx.busy, '切页取消：放开').toEqual([]);
    await act(async () => {
      hang();
    });
  });

  it('已经开始写库时切页：照常存完、不撤；回到有“＋”的页出“已记下”，busy 存完才放开', async () => {
    let open!: () => void;
    const writer = {
      insert: vi.fn<Writer['insert']>(() => new Promise<WriteResult>((ok) => (open = () => ok(OK)))),
      patch: vi.fn<Writer['patch']>(async () => OK),
    };
    const session = createVoiceSession({ callVoice: async () => VOICE_OK, writer, online: () => true });
    const { unmount } = setup({ session });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    unmount();
    expect(logged(/^voice host detach status=organizing cancel=0$/)).toBe(true);
    expect(fx.busy, '写库中：占着').toEqual(['recording']);
    await act(async () => {
      open();
    });
    setup({ session });
    expect((await screen.findByTestId('type-notice')).textContent).toContain('已记下：买猫砂');
    expect(logged(/^voice attempt \d+ drop by=/)).toBe(false);
    await waitFor(() => expect(fx.busy, '存完放开').toEqual([]));
  });

  it('已经开始写库后这一次被作废（dispose 等任何 drop）：照样落地、出“已记下”，状态不卡在“正在整理”（整块评审第 7 条：开始写库的一定落地）', async () => {
    let open!: () => void;
    const writer = {
      insert: vi.fn<Writer['insert']>(() => new Promise<WriteResult>((ok) => (open = () => ok(OK)))),
      patch: vi.fn<Writer['patch']>(async () => OK),
    };
    const session = createVoiceSession({ callVoice: async () => VOICE_OK, writer, online: () => true });
    setup({ session });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    act(() => session.dispose());
    expect(logged(/^voice attempt \d+ drop by=dispose$/)).toBe(true);
    await act(async () => {
      open();
    });
    expect(session.view().status, '收了尾（不卡在 organizing）').toBe('saved');
    expect((await screen.findByTestId('type-notice')).textContent).toContain('已记下：买猫砂');
  });

  it('手机自带识别那一路等 AI 时切页：AI 请求当场中止（不等 6 秒超时），不写库（整块评审第 6 条）', async () => {
    const got: { sig?: AbortSignal } = {};
    const callAi = vi.fn<CallAi>((_req, signal) => {
      got.sig = signal;
      return new Promise((_ok, no) => signal.addEventListener('abort', () => no(new DOMException('cancelled', 'AbortError'))));
    });
    const { writer, session, unmount } = setup({ call: async () => ({ ai_failed: true, reason: 'error' }), callAi });
    await holdDown();
    await release();
    // “AI 没回应”→“再说一次”：改用手机自带识别（面板直接是锁定的样子），点“记下”交出文字
    fireEvent.click(await screen.findByTestId('voice-again'));
    await waitFor(() => expect(session.view().status).toBe('listening'));
    await act(async () => {
      session.finish();
    });
    await waitFor(() => expect(callAi).toHaveBeenCalledTimes(1));
    expect(got.sig?.aborted).toBe(false);
    unmount();
    expect(logged(/^voice host detach status=organizing cancel=1$/)).toBe(true);
    expect(got.sig?.aborted, '切页：AI 请求跟着中止').toBe(true);
    await sleep(20);
    expect(writer.insert).not.toHaveBeenCalled();
  });

  it('停在确认行（过去的月日，R-166）：busy 照样占着，自动重新载入不会把等着选的那一条丢掉；选完才放开（第二轮复查续第 3 条）', async () => {
    const past = { ...ITEM, title: '交房租', due: '2026-10-30', date_basis: 'md', confirm: { past: '2026-10-30', next: '2027-10-30' } };
    const { writer } = setup({ call: async () => ({ ...VOICE_OK, transcript: '10 月 30 号交房租', items: [past] }) });
    await holdDown();
    await release();
    const row = await screen.findByTestId('type-confirm');
    expect(fx.busy, '确认行出着：占着').toEqual(['recording']);
    expect(writer.insert, '还没选：没存').not.toHaveBeenCalled();
    const pastBtn = row.querySelector('button');
    if (!pastBtn) throw new Error('确认行没有按钮');
    fireEvent.click(pastBtn);
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fx.busy, '选完放开').toEqual([]));
  });

  it('录着时切页：算取消（停录、不上传、不写库），麦克风不留着', async () => {
    const { writer, call, unmount } = setup();
    await holdDown();
    expect(fx.starts).toBe(1);
    unmount();
    await nothingKept(writer, call);
    expect(logged(/^voice host detach status=recording cancel=1$/)).toBe(true);
  });

  it('开录时弹了 iOS 系统麦克风框（录音器 1.5 秒以上才开起来），手指先松开了：这一下不录，提示“麦克风已允许，再按住“＋”说话”，没有按钮（R-417）', async () => {
    fx.startHang = true;
    const { writer, call } = setup();
    await holdDown();
    await release();
    vi.mocked(clock.now).mockReturnValue(NOW + 2000);
    await act(async () => fx.startOpen?.());
    const note = await screen.findByTestId('voice-notice');
    expect(note.dataset['note']).toBe('mic_ready');
    expect(note.textContent).toContain('麦克风已允许，再按住“＋”说话');
    expect(note.querySelectorAll('[data-testid^="voice-"]:not([data-testid="voice-notice-close"])'), '没有“再说一次”“改用打字”').toHaveLength(0);
    expect(logged(/^voice mic_ready waited_ms=2000$/)).toBe(true);
    expect(call).not.toHaveBeenCalled();
    expect(writer.insert).not.toHaveBeenCalled();
  });

  it('松手早、录音器很快就开起来（不到 1.5 秒，没弹系统框）：当太短丢掉，不出“麦克风已允许”', async () => {
    fx.startHang = true;
    const { writer, call } = setup();
    await holdDown();
    await release();
    vi.mocked(clock.now).mockReturnValue(NOW + 300);
    await act(async () => fx.startOpen?.());
    await nothingKept(writer, call);
    expect(logged(/mic_ready/)).toBe(false);
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
    // 只开了录音这一路边说边出字的识别（录音器开起来以后，R-470），没开手机自带识别那一路
    expect(fx.speech.map((r) => r.live)).toEqual([true]);
    expect(logged(/^voice hold start .* route=rec$/)).toBe(true);
  });
});

// R-456：录音这一路边说边出字、松手先按本机规则存、AI 在后台整理（部分取代 R-62“录音时不边说边出字、等 AI 回来才存”）
describe('边说边出字、先存、AI 后台整理（R-456）', () => {
  const TWO = { ...VOICE_OK, transcript: '买牛奶，明天下午三点开会', items: [{ ...ITEM, title: '买牛奶' }, { ...ITEM, kind: 'event', title: '开会', date: '2026-11-03', time: '15:00' }] };
  /** 写进去的第几条的 id、标题 */
  const ins = (w: { insert: { mock: { calls: unknown[][] } } }, i: number) => w.insert.mock.calls[i]?.[1] as { id: string; title: string };
  /** AI 那一步先卡住，测试里放开 */
  const held = () => {
    const box: { open: (v: unknown) => void } = { open: () => undefined };
    const call = () => new Promise((ok) => (box.open = ok));
    return { box, call };
  };

  it('按住时面板上实时出字（深底大框在计时上方）；松手不等 AI 当场按本机规则存，出“已记下”、不转圈、busy 放开', async () => {
    fx.liveSay = '买牛奶';
    const ai = held();
    const { writer, call } = setup({ call: ai.call });
    await holdDown();
    const run = fx.speech.at(-1);
    expect(run?.live, '录音这一路也开了识别').toBe(true);
    await act(async () => run?.text('买牛'));
    expect(screen.getByTestId('rec-live').textContent).toBe('买牛');
    await act(async () => run?.text('买牛奶'));
    expect(screen.getByTestId('rec-live').textContent).toBe('买牛奶');
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    expect(ins(writer, 0).title).toBe('买牛奶');
    expect((await screen.findByTestId('type-notice')).textContent).toContain('已记下：买牛奶');
    expect(screen.queryByTestId('voice-work'), '不转圈').toBeNull();
    expect(live?.view().status).toBe('saved');
    await waitFor(() => expect(call, '后台照样上传同一段录音').toHaveBeenCalledTimes(1));
    expect(fx.busy, '后台整理期间不占 busy').toEqual([]);
    expect(logged(/^voice live take=1 after=rec ms=\d+$/)).toBe(true);
    expect(logged(/^voice live end speech=ok len=3 rec=ok bytes=2000$/)).toBe(true);
    expect(logged(/^voice live saved out=ok n=1 ai=0 ms=\d+$/)).toBe(true);
    expect(log.some((l) => l.includes('买牛奶')), '不记说的内容').toBe(false);
    await act(async () => ai.box.open({ ...VOICE_OK, transcript: '买牛奶', items: [{ ...ITEM, title: '买牛奶' }] }));
  });

  it('诊断开关 Live speech 关着（lemo-live-speech-off=1）：录音这一路不开识别，日志 take=0 off=diag，松手整段上传等 AI（负责人 11-18 对照用）', async () => {
    localStorage.setItem('lemo-live-speech-off', '1');
    try {
      const ai = held();
      const { call } = setup({ call: ai.call });
      const before = fx.speech.length;
      await holdDown();
      expect(fx.speech.length, '没开识别').toBe(before);
      expect(logged(/^voice live take=0 after=rec ms=\d+ off=diag$/)).toBe(true);
      await release();
      await waitFor(() => expect(call, '整段上传').toHaveBeenCalledTimes(1));
      await act(async () => ai.box.open({ ...VOICE_OK, transcript: '买牛奶', items: [{ ...ITEM, title: '买牛奶' }] }));
    } finally {
      localStorage.removeItem('lemo-live-speech-off');
    }
  });

  it('AI 回来和先存的一样：什么都不做（不再写、不撤），日志 out=same', async () => {
    fx.liveSay = '买牛奶';
    const ai = held();
    const { writer } = setup({ call: ai.call });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    await act(async () => ai.box.open({ ...VOICE_OK, transcript: '买牛奶', items: [{ ...ITEM, title: '买牛奶' }] }));
    await waitFor(() => expect(logged(/^voice live ai via=voice out=same ms=\d+$/)).toBe(true));
    expect(writer.insert).toHaveBeenCalledTimes(1);
    expect(writer.patch).not.toHaveBeenCalled();
    expect(screen.getByTestId('type-notice').textContent).not.toContain('AI 已整理');
  });

  it('AI 回来拆得不一样：先存 AI 的、再撤先存的，提示条写“AI 已整理”，“全部撤销”撤的是 AI 那两条；换的那一下占住 busy', async () => {
    fx.liveSay = '买牛奶明天下午三点开会';
    const ai = held();
    const { writer } = setup({ call: ai.call });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    const first = ins(writer, 0).id;
    let busyAtSwap: string[] = [];
    writer.insert.mockImplementation(async () => {
      busyAtSwap = [...fx.busy];
      return OK;
    });
    await act(async () => ai.box.open(TWO));
    await waitFor(() => expect(logged(/^voice live ai via=voice out=replaced ms=\d+$/)).toBe(true));
    expect(busyAtSwap, '换的时候占着').toEqual(['recording']);
    expect(fx.busy, '换完放开').toEqual([]);
    expect([1, 2].map((i) => ins(writer, i).title)).toEqual(['买牛奶', '开会']);
    expect(writer.patch.mock.calls.map((c) => c[1]), '撤了先存的那条').toEqual([first]);
    const notice = await screen.findByTestId('type-notice');
    expect(notice.textContent).toContain('已记下 2 条');
    expect(notice.textContent).toContain('AI 已整理');
    fireEvent.click(screen.getByText('展开'));
    fireEvent.click(screen.getByText('全部撤销'));
    const ids = [1, 2].map((i) => ins(writer, i).id);
    await waitFor(() => expect(writer.patch.mock.calls.map((c) => c[1])).toEqual([first, ...ids]));
  });

  it('提示条 8 秒到了（或点 ×）以后 AI 才回来：库里照样换，提示条不再弹出来', async () => {
    fx.liveSay = '买牛奶明天下午三点开会';
    const ai = held();
    const { writer, session } = setup({ call: ai.call });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    act(() => session.batch.closeNotice());
    expect(screen.queryByTestId('type-notice')).toBeNull();
    await act(async () => ai.box.open(TWO));
    await waitFor(() => expect(logged(/out=replaced/)).toBe(true));
    expect(writer.insert, '库里换了：AI 那两条存上').toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId('type-notice'), '关掉了的不再弹出来').toBeNull();
  });

  it('AI 回来之前用户已经撤销了这一批：不替换（不再写库），日志 out=skip_touched', async () => {
    fx.liveSay = '买牛奶明天下午三点开会';
    const ai = held();
    const { writer } = setup({ call: ai.call });
    await holdDown();
    await release();
    fireEvent.click(await screen.findByText('撤销'));
    await waitFor(() => expect(writer.patch).toHaveBeenCalledTimes(1));
    await act(async () => ai.box.open(TWO));
    await waitFor(() => expect(logged(/^voice live ai via=voice out=skip_touched ms=\d+$/)).toBe(true));
    expect(writer.insert).toHaveBeenCalledTimes(1);
  });

  it('AI 回来之前又按住说了新的一句：不替换上一句，日志 out=skip_touched', async () => {
    fx.liveSay = '买牛奶明天下午三点开会';
    const ai = held();
    const { writer } = setup({ call: ai.call });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    const firstBox = ai.box.open;
    await holdDown();
    await act(async () => firstBox(TWO));
    await waitFor(() => expect(logged(/out=skip_touched/)).toBe(true));
    expect(writer.insert).toHaveBeenCalledTimes(1);
    await release();
  });

  it('AI 失败（没回应）：先存的留着，不出“重试 / 再说一次”，日志 out=failed_error', async () => {
    fx.liveSay = '买牛奶';
    const { writer } = setup({ call: async () => ({ ai_failed: true, reason: 'error' }) });
    await holdDown();
    await release();
    await waitFor(() => expect(logged(/^voice live ai via=voice out=failed_error ms=\d+$/)).toBe(true));
    expect(writer.insert).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('voice-notice'), '不让人重说').toBeNull();
    expect(screen.getByTestId('type-notice').textContent).toContain('已记下：买牛奶');
  });

  it('先存以后切页：后台整理不取消，照样换掉', async () => {
    fx.liveSay = '买牛奶明天下午三点开会';
    const ai = held();
    const { writer, unmount } = setup({ call: ai.call });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    unmount();
    expect(logged(/^voice host detach status=saved cancel=0$/)).toBe(true);
    await act(async () => ai.box.open(TWO));
    await waitFor(() => expect(logged(/out=replaced/)).toBe(true));
    expect(writer.insert).toHaveBeenCalledTimes(3);
  });

  it('识别报错（iPhone 上和录音抢麦克风那种）：完全照原来，松手上传、等 AI 回来再存', async () => {
    fx.liveFail = 'error';
    const { writer, call } = setup();
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledTimes(1);
    expect(ins(writer, 0).title).toBe('买猫砂');
    expect(logged(/^voice live end speech=error len=0 rec=ok bytes=2000$/)).toBe(true);
    expect(logged(/voice live saved/)).toBe(false);
  });

  it('识别开着但一个字也没认出：照原来上传、等 AI 再存，面板上不出字框', async () => {
    const { writer } = setup();
    await holdDown();
    expect(screen.queryByTestId('rec-live')).toBeNull();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    expect(ins(writer, 0).title).toBe('买猫砂');
    expect(logged(/^voice live end speech=ok len=0 rec=ok bytes=2000$/)).toBe(true);
  });

  it('录音器开不起来、识别在听而且有字：照样先存，后台把字交给 ai-parse 整理（不传录音）', async () => {
    fx.startFail = 'start_failed';
    // 没说日子：本机规则没把握，才交 ai-parse（有把握的和打字一样不调 AI，日志 out=skip_local）
    fx.liveSay = '买牛奶';
    const callAi = vi.fn<CallAi>(async () => TWO);
    const { call } = setup({ callAi });
    await holdDown();
    expect((await screen.findByTestId('rec-panel')).dataset['status'], '接着听').toBe('recording');
    expect(logged(/^voice live rec_fail=start_failed keep=speech$/)).toBe(true);
    await release();
    await waitFor(() => expect(logged(/^voice live ai via=parse out=replaced ms=\d+$/)).toBe(true));
    expect(call, '没有录音可传').not.toHaveBeenCalled();
    expect(callAi).toHaveBeenCalledTimes(1);
    expect(logged(/^voice live end speech=ok len=3 rec=off bytes=0$/)).toBe(true);
    expect((await screen.findByTestId('type-notice')).textContent).toContain('AI 已整理');
  });

  it('录音器停录失败、识别有字：照样先存，后台交 ai-parse', async () => {
    fx.stopEnd = { ok: false, fail: 'rec_error' };
    fx.liveSay = '买牛奶';
    const callAi = vi.fn<CallAi>(async () => ({ ...VOICE_OK, items: [{ ...ITEM, title: '买牛奶' }] }));
    const { writer, call } = setup({ callAi });
    await holdDown();
    await release();
    await waitFor(() => expect(logged(/^voice live ai via=parse out=same ms=\d+$/)).toBe(true));
    expect(call).not.toHaveBeenCalled();
    expect(writer.insert).toHaveBeenCalledTimes(1);
  });
  it('只点一下“＋”（没按满 350 ms）：录音这一路按下时不开识别，什么都没开', async () => {
    setup();
    act(() => hold.onStart(ptr()));
    await sleep(40);
    expect(fx.speech, '按下那一下没开识别（R-470）').toEqual([]);
    await release();
    await sleep(HOLD_MS);
    expect(fx.speech).toEqual([]);
    expect(fx.starts).toBe(0);
  });

  // R-470（负责人 11-17：“有时候说话语音不识别，那个说话时的波动条也不动”“第一次语音输入正常，之后就不行”）：
  // iPhone 主屏幕版上识别先占了麦克风，录音器随后拿到的流全是 0。改成录音器开起来以后才开识别
  it('先录音、后识别：录音器还没开起来（等 getUserMedia）时识别没开；录音器开起来以后才开，日志 take=1 after=rec', async () => {
    fx.startHang = true;
    fx.liveSay = '买牛奶';
    const { writer } = setup({ call: held().call });
    await holdDown();
    expect(fx.starts, '录音器在开').toBe(1);
    expect(fx.speech, '录音器没开起来之前识别不开').toEqual([]);
    await act(async () => fx.startOpen?.());
    await waitFor(() => expect(fx.speech.map((r) => r.live)).toEqual([true]));
    expect((await screen.findByTestId('rec-panel')).dataset['status']).toBe('recording');
    const take = log.findIndex((l) => /^voice live take=1 after=rec ms=\d+$/.test(l));
    const rec = log.findIndex((l) => /^voice preparing->recording /.test(l));
    expect(rec, '先进录音中').toBeGreaterThanOrEqual(0);
    expect(take, '再开识别').toBeGreaterThan(rec);
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    expect(ins(writer, 0).title).toBe('买牛奶');
  });

  it('录音器开起来以后识别开不起来（不在手势里那种）：只丢边说边出字，录音照原来上传、等 AI 再存', async () => {
    fx.liveRefuse = true;
    const { writer, call } = setup();
    await holdDown();
    expect((await screen.findByTestId('rec-panel')).dataset['status']).toBe('recording');
    expect(logged(/^voice live take=0 after=rec ms=\d+$/)).toBe(true);
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledTimes(1);
    expect(ins(writer, 0).title).toBe('买猫砂');
    expect(logged(/^voice live end speech=off len=0 rec=ok bytes=2000$/)).toBe(true);
  });

  it('录音器开起来以后识别报 not-allowed（denied）：不出“麦克风被拒”卡，录音照原来上传', async () => {
    fx.liveFail = 'denied';
    const { writer, call } = setup();
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledTimes(1);
    expect(live?.view().card, '不出说明卡').toBeNull();
    expect(logged(/^voice live end speech=denied len=0 rec=ok bytes=2000$/)).toBe(true);
  });

  it('松手前识别自己结束了、手指还按着：自动重开一次，新认出的字接在后面，先存整句；日志 restart n=1 ok=1', async () => {
    fx.liveSay = '明天下午三点开会';
    const { writer } = setup({ call: held().call });
    await holdDown();
    await act(async () => fx.speech[0]?.end({ ok: true, text: '买牛奶' }));
    expect(fx.speech.filter((r) => r.live)).toHaveLength(2);
    expect(logged(/^voice live restart n=1 ok=1$/)).toBe(true);
    await act(async () => fx.speech[1]?.text('明天'));
    expect(screen.getByTestId('rec-live').textContent).toBe('买牛奶明天');
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalled());
    expect(logged(/^voice live end speech=ok len=11 rec=ok bytes=2000$/), '两段接起来交给先存').toBe(true);
    expect(logged(/^voice live saved out=ok n=\d+ ai=0 ms=\d+$/)).toBe(true);
  });

  it('重开开不起来：这一次不先存，整段上传、等 AI 回来再存；日志 restart n=1 ok=0、end speech=broken', async () => {
    const { writer, call } = setup();
    await holdDown();
    fx.liveRefuse = true;
    await act(async () => fx.speech[0]?.end({ ok: true, text: '买牛奶' }));
    expect(logged(/^voice live restart n=1 ok=0$/)).toBe(true);
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledTimes(1);
    expect(ins(writer, 0).title, 'AI 那一份').toBe('买猫砂');
    expect(logged(/^voice live end speech=broken len=3 rec=ok bytes=2000$/)).toBe(true);
    expect(logged(/voice live saved/)).toBe(false);
  });

  it('重开以后又提前结束：不再重开，整段上传', async () => {
    const { writer, call } = setup();
    await holdDown();
    await act(async () => fx.speech[0]?.end({ ok: true, text: '买牛奶' }));
    await act(async () => fx.speech[1]?.end({ ok: true, text: '开会' }));
    expect(logged(/^voice live restart n=2 ok=0$/)).toBe(true);
    expect(fx.speech.filter((r) => r.live)).toHaveLength(2);
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledTimes(1);
    expect(ins(writer, 0).title).toBe('买猫砂');
  });

  it('松手时识别还没开始收音：当场关掉、当没开，不白等，照原来上传；日志 not_started', async () => {
    fx.liveNoStart = true;
    fx.liveSay = '买牛奶';
    const { writer, call } = setup();
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1), { timeout: 800 });
    expect(call).toHaveBeenCalledTimes(1);
    expect(fx.speech[0]?.cancelled).toBe(true);
    expect(logged(/^voice live not_started$/)).toBe(true);
    expect(logged(/^voice live end speech=off len=0 rec=ok bytes=2000$/)).toBe(true);
  });

  it('等识别结局时点“取消”：识别关掉，不存、不上传', async () => {
    fx.liveHang = true;
    fx.liveSay = '买牛奶';
    const { writer, call } = setup();
    await holdDown();
    await release();
    fireEvent.click(await screen.findByText('取消'));
    await act(async () => fx.speech[0]?.end({ ok: true, text: '买牛奶' }));
    await sleep(30);
    expect(fx.speech[0]?.cancelled).toBe(true);
    expect(writer.insert).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(live?.view().live, '字清掉').toBe('');
  });

  it('本机规则判成查找：不先存，照原来整段上传给 ai-voice', async () => {
    fx.liveSay = '找一下发票';
    const { writer, call } = setup();
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledTimes(1);
    expect(ins(writer, 0).title).toBe('买猫砂');
    expect(logged(/voice live saved/)).toBe(false);
  });

  it('录音器没录成、识别正常结束但没认出字：出 no_speech，不出“录音没开起来”', async () => {
    fx.startFail = 'start_failed';
    const { writer } = setup();
    await holdDown();
    await release();
    const note = await screen.findByTestId('voice-notice');
    expect(note.dataset['note']).toBe('no_speech');
    expect(writer.insert).not.toHaveBeenCalled();
  });

  it('替换进行中：提示条上的按钮全部禁用，点“撤销”不撤', async () => {
    fx.liveSay = '买牛奶明天下午三点开会';
    const ai = held();
    const { writer } = setup({ call: ai.call });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    const first = ins(writer, 0).id;
    const gate: { open: () => void } = { open: () => undefined };
    writer.insert.mockImplementationOnce(() => new Promise<WriteResult>((ok) => (gate.open = () => ok(OK))));
    await act(async () => ai.box.open(TWO));
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(2));
    const buttons = [...screen.getByTestId('type-notice').querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => b.disabled), '全部禁用').toBe(true);
    for (const b of buttons) fireEvent.click(b);
    await act(async () => gate.open());
    await waitFor(() => expect(logged(/out=replaced/)).toBe(true));
    expect(writer.patch.mock.calls.map((c) => c[1]), '只撤了先存的那条（换的那一步），没有多撤').toEqual([first]);
  });

  it('在别处改过先存的那条以后 AI 才回来：不换，日志 out=skip_touched', async () => {
    fx.liveSay = '买牛奶明天下午三点开会';
    const ai = held();
    const { writer } = setup({ call: ai.call });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    const first = ins(writer, 0);
    const table = String(writer.insert.mock.calls[0]?.[0]);
    collection(table).upsert([{ ...first, updated_at: NOW + 1000, deleted_at: null, done_at: null } as never]);
    await act(async () => ai.box.open(TWO));
    await waitFor(() => expect(logged(/^voice live ai via=voice out=skip_touched ms=\d+$/),).toBe(true));
    expect(writer.insert).toHaveBeenCalledTimes(1);
  });

  it('松手后超过 20 秒 AI 才回来：不换，日志 out=skip_late', async () => {
    fx.liveSay = '买牛奶明天下午三点开会';
    const ai = held();
    const { writer } = setup({ call: ai.call });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    const real = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => real() + LIVE_LATE_MS + 1000);
    await act(async () => ai.box.open(TWO));
    await waitFor(() => expect(logged(/^voice live ai via=voice out=skip_late ms=\d+$/)).toBe(true));
    expect(writer.insert).toHaveBeenCalledTimes(1);
    expect(writer.patch).not.toHaveBeenCalled();
  });
});
