// 按住“＋”录音的整条流程（ui/RecordHost.tsx + hooks/useVoice.ts；B3 FA-3）。录音器、音频上下文、Gemini 令牌和会话用桩（platform 那几个文件另有单测），
// ai-voice 和写入用桩：按住 350 ms 开录、录着时压住提醒横幅、松手上传并记下（source = voice）、录满自动结束、离线直接提示、
// AI 没开、额度用完按下就挡（不开麦克风，负责人 11-24），麦克风没问过先出说明卡、AI 没回应可以重试（同一段录音）、“再说一次”走同一条路、
// 不认识的 intent 用转写走本机规则；Gemini 实时转写边说边出字（R-456）：先按本机规则存、AI 后台整理换掉或不换、没出字照旧上传录音。
// 11-24 起只有录音 + Gemini 一条路，手机自带识别那一支（voice-speech.ts、platform/speech.ts）和它的用例整块删掉
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
import type { LiveEnd, LiveOpts, LiveSession } from '../../../platform/live-transcribe.ts';
import type * as Boot from '../../../core/boot.ts';
import type * as Router from '../../../app/router.ts';
import type { LiveTokenRes } from '../data/live-token-api.ts';
import type { Writer } from '../data/capture-save.ts';
import type * as Quota from '../data/quota.ts';
import type { CallAi } from '../data/type-flow.ts';
import type * as VoiceFlow from '../data/voice-flow.ts';
import type { HoldPointer } from '../data/hold-input.ts';
import { hold } from '../hooks/voice-sink.ts';
import { PRESS_HOLD_MS as HOLD_MS } from '../../../../shared/logic/gesture.ts';
import { LIVE_LATE_MS } from '../data/voice-pending.ts';
import { createVoiceSession, type VoiceSession } from '../data/voice-session.ts';
import { RecordHost } from '../ui/RecordHost.tsx';

const SID = 'sid-v';
vi.mock('../../../platform/session.ts', async (orig) => ({ ...(await orig<typeof Session>()), readSessionId: () => SID }));

const fx = vi.hoisted(() => ({
  starts: 0,
  autoStop: null as null | (() => void),
  stops: 0,
  /** 挂不挂 Gemini 实时转写（live-audio 的 liveSupported）：默认不挂（同 jsdom 没有 AudioWorklet），实时转写那一组打开 */
  gem: false,
  /** 令牌回什么 */
  gemTok: { ok: true, t: { token: 'auth_tokens/x', api: 'v1beta', setup: {} } } as LiveTokenRes,
  /** 会话收尾交出的字：空串 = 没出字，照旧上传录音 */
  gemSay: '',
  /** 会话收尾先卡住（测试里调 gemOpen） */
  gemHang: false,
  gemOpen: null as null | (() => void),
  /** 开过几个会话、最近一个的选项（onText 往面板出字） */
  gemOpens: 0,
  gemOpts: null as null | LiveOpts,
  /** “去打开”跳到哪 */
  nav: [] as unknown[][],
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
vi.mock('../../../app/router.ts', async (orig) => ({
  ...(await orig<typeof Router>()),
  navigate: (...a: unknown[]) => void fx.nav.push(a),
}));
vi.mock('../../../platform/live-audio.ts', () => ({
  liveSupported: () => fx.gem,
  geminiLiveOn: () => true,
  openAudioCtx: () => ({ state: 'running' }),
  closeAudioCtx: () => undefined,
}));
vi.mock('../../../platform/recorder.ts', () => ({
  recorderSupported: () => true,
  requestMic: async () => 'granted',
  startRecorder: async (o: { onAutoStop?: () => void; signal?: AbortSignal; onStream?: (s: MediaStream) => void }) => {
    fx.starts += 1;
    fx.autoStop = o.onAutoStop ?? null;
    fx.signal = o.signal ?? null;
    o.onStream?.({} as MediaStream);
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
/** Gemini Live 会话的桩：发出去的音和录音一样长（7 秒），收尾交出 fx.gemSay */
const STATS = { connMs: 300, firstMs: 900, len: 3, capMs: 7000, sentMs: 7000, audioAt: null, backlogMs: 0, nInterim: 1, nFinal: 1, nModel: 0 };
function gemSession(o: LiveOpts): LiveSession {
  fx.gemOpens += 1;
  fx.gemOpts = o;
  const end = (): LiveEnd => ({ ok: true, text: fx.gemSay, stats: STATS });
  return {
    connect: () => undefined,
    fail: () => undefined,
    level: () => 0.5,
    finish: () => (fx.gemHang ? new Promise<LiveEnd>((ok) => (fx.gemOpen = () => ok(end()))) : Promise.resolve(end())),
    close: () => undefined,
  } as unknown as LiveSession;
}

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

/** 写入口的桩（vi.fn，测试里看调用） */
type WriterMock = { insert: ReturnType<typeof vi.fn<Writer['insert']>>; patch: ReturnType<typeof vi.fn<Writer['patch']>> };

/** 这条用例的控制器（用完 dispose） */
let live: VoiceSession | null = null;

/** 挂一份 RecordHost；session 给了就重挂那一份（切页回来），不给就新建一份带桩的控制器。
 *  松手一律先存（没出字存占位，voice-pending.ts）；要测前台上传那条路的，用 firstFails 让占位存不上、点“重试”（11-24 评审：删掉 park 开关） */
function setup(o: { call?: (...a: unknown[]) => Promise<unknown>; callAi?: CallAi; online?: () => boolean; onType?: () => void; session?: VoiceSession; writer?: WriterMock } = {}) {
  const writer = o.writer ?? { insert: vi.fn<Writer['insert']>(async () => OK), patch: vi.fn<Writer['patch']>(async () => OK) };
  const call = vi.fn(o.call ?? (async () => VOICE_OK));
  const session =
    o.session ??
    createVoiceSession({
      callVoice: call, callAi: o.callAi, writer, online: o.online ?? (() => true),
      live: { token: async () => fx.gemTok, open: async (op) => gemSession(op) },
    });
  live = session;
  const r = render(<RecordHost session={session} onType={o.onType} />);
  return { writer, call, session, unmount: r.unmount };
}

/** 写入口桩：第一次写（松手先存的占位）写不进，之后照常——走“占位存不上 → 录音留着、提示条“重试” → 前台上传”那条路 */
function firstFails(): WriterMock {
  let n = 0;
  return {
    insert: vi.fn<Writer['insert']>(async (): Promise<WriteResult> => (++n === 1 ? { ok: false, reason: 'local_unavailable' } : OK)),
    patch: vi.fn<Writer['patch']>(async () => OK),
  };
}
/** 按住、松手，占位存不上：等提示条出“AI 没回应 · 重试”（录音留着） */
async function toKept(): Promise<void> {
  await holdDown();
  await release();
  expect((await screen.findByTestId('voice-notice')).dataset['note']).toBe('ai_failed');
}
/** 写进去的标题（按顺序，含写不进的那一次） */
const titles = (w: WriterMock): string[] => w.insert.mock.calls.map((c) => (c[1] as unknown as { title: string }).title);

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
  fx.gem = false;
  fx.gemTok = { ok: true, t: { token: 'auth_tokens/x', api: 'v1beta', setup: {} } };
  fx.gemSay = '买牛奶';
  fx.gemHang = false;
  fx.gemOpen = null;
  fx.gemOpens = 0;
  fx.gemOpts = null;
  fx.nav = [];
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
  collection('todos').clear();
  setConsentStale(false, null);
  localStorage.removeItem(MIC_PERM_KEY);
  remindQueue.setState({ holds: [] });
  delete (globalThis as Record<string, unknown>)[RL_SLOT];
  vi.restoreAllMocks();
});

describe('按住“＋”录音', () => {
  it('按住 350 ms 开录（录着时压住提醒横幅）；松手先存占位、录音后台上传，换成 AI 的（source = voice），出“已记下 · 撤销”', async () => {
    const { writer, call } = setup();
    await holdDown();
    expect(fx.starts).toBe(1);
    const panel = await screen.findByTestId('rec-panel');
    expect(panel.dataset['status']).toBe('recording');
    expect(screen.getByTestId('rec-cancel-zone').textContent).toBe('↑ 拖到这里取消');
    expect(remindQueue.getState().holds.map((h) => h.reason)).toEqual(['recording']);
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(2));
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[0]).toMatchObject({ mime: 'audio/mp4' });
    expect(writer.insert.mock.calls[0]?.[1]).toMatchObject({ title: '语音记录 · 整理中', source: 'voice' });
    expect(writer.insert.mock.calls[1]?.[1]).toMatchObject({ title: '买猫砂', source: 'voice' });
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

  it('前台上传 AI 这次没回应：录音留着，“重试”用同一段录音再发一次', async () => {
    let n = 0;
    const writer = firstFails();
    const { call } = setup({
      writer,
      call: async () => {
        n += 1;
        return n === 1 ? { ai_failed: true, reason: 'error' } : VOICE_OK;
      },
    });
    await toKept();
    fireEvent.click(screen.getByTestId('voice-retry'));
    await waitFor(() => {
      expect(call).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('voice-notice').dataset['note']).toBe('ai_failed');
    });
    const first = call.mock.calls[0]?.[0] as { audio: Blob };
    fireEvent.click(screen.getByTestId('voice-retry'));
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(2));
    expect((call.mock.calls[1]?.[0] as { audio: Blob }).audio).toBe(first.audio);
  });

  it('不认识的 intent 但带着转写：用转写走本机规则记下，原话不丢', async () => {
    const writer = firstFails();
    setup({ writer, call: async () => ({ ...VOICE_OK, intent: 'summarize' }) });
    await toKept();
    fireEvent.click(screen.getByTestId('voice-retry'));
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(2));
    expect(writer.insert.mock.calls[1]?.[1]).toMatchObject({ title: '买猫砂', source: 'voice' });
    expect((await screen.findByTestId('type-notice')).textContent).toContain('已先记下');
  });

  it('网络原因连着失败两次：之后按住照样开录音器、整段上传（11-24 起不再改用手机自带识别）', async () => {
    const { call } = setup({
      call: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    for (let i = 0; i < 3; i += 1) {
      await holdDown();
      await release();
      await waitFor(() => expect(log.filter((l) => /^voice tidy path=pending out=failed_/.test(l))).toHaveLength(i + 1));
    }
    expect(fx.starts, '三次都开了录音器').toBe(3);
    expect(call.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  // 负责人 11-24：“ai没开的时候就提示录音暂时无法使用，我说半天在提升用键盘打，那不是很遭人恨吗”
  it('AI 没开：按住那一刻就提示“语音暂时用不了”，不开麦克风、不录音；“去打开”收起提示、打开设置 › 语音与 AI，“改用打字”打开打字条', async () => {
    collection('settings').clear();
    const onType = vi.fn();
    const { call, writer } = setup({ onType });
    await holdDown();
    expect(fx.starts, '没开录音器').toBe(0);
    expect(screen.queryByTestId('rec-panel')?.dataset['status'] ?? 'idle').toBe('idle');
    const note = await screen.findByTestId('voice-notice');
    expect(note.dataset['note']).toBe('ai_off');
    expect(note.textContent).toContain('语音暂时用不了');
    expect(note.textContent).toContain('AI 没开');
    expect(logged(/^voice hold start online=1 mic=granted route=off gm=unsup$/)).toBe(true);
    await release();
    expect(fx.starts, '松手也没开').toBe(0);
    fireEvent.click(screen.getByTestId('voice-open'));
    expect(fx.nav).toEqual([['settings', 'ai']]);
    expect(screen.queryByTestId('voice-notice')).toBeNull();
    await holdDown();
    await release();
    fireEvent.click(await screen.findByTestId('voice-type'));
    expect(onType).toHaveBeenCalledTimes(1);
    expect(call).not.toHaveBeenCalled();
    expect(writer.insert).not.toHaveBeenCalled();
  });

  it('已知今天额度用完：按住那一刻就提示“语音暂时用不了”和几点恢复，不开麦克风、不录音，只给“改用打字”', async () => {
    fx.quotaOut = true;
    const { call } = setup();
    await sleep(10); // 挂上时从本机读额度（异步），读回来再按
    await holdDown();
    expect(fx.starts, '没开录音器').toBe(0);
    const note = await screen.findByTestId('voice-notice');
    expect(note.dataset['note']).toBe('quota');
    expect(note.textContent).toContain('语音暂时用不了');
    expect(note.textContent).toMatch(/今天的 AI 次数用完了，(今天|明天) \d{2}:\d{2} 恢复/);
    expect(screen.queryByTestId('voice-again'), '不给“再说一次”').toBeNull();
    expect(screen.getByTestId('voice-type')).toBeTruthy();
    expect(logged(/^voice hold start .* route=quota gm=unsup$/)).toBe(true);
    await release();
    expect(call).not.toHaveBeenCalled();
  });

  it('前台上传中（点了“重试”）点“取消”：回到没按的状态，不记', async () => {
    let hang!: () => void;
    const writer = firstFails();
    setup({ writer, call: () => new Promise((ok) => (hang = () => ok(VOICE_OK))) });
    await toKept();
    fireEvent.click(screen.getByTestId('voice-retry'));
    fireEvent.click(await screen.findByTestId('voice-cancel'));
    hang();
    await sleep(20);
    expect(screen.queryByTestId('voice-work')).toBeNull();
    expect(writer.insert, '只有写不进的那一次占位').toHaveBeenCalledTimes(1);
  });

  it('运行日志：每次状态转换一行（状态名），结果带字节数和毫秒；不记转写、不记标题', async () => {
    setup();
    await holdDown();
    await release();
    await waitFor(() => expect(logged(/^voice tidy path=pending out=replaced /)).toBe(true));
    expect(log).toEqual(
      expect.arrayContaining([
        'voice idle->preparing',
        'voice preparing->recording',
        'voice recording->uploading',
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

  it('前台上传前那一步（toUpload）还没完时点“取消”：不上传、不写库', async () => {
    const writer = firstFails();
    const { call } = setup({ writer });
    await toKept();
    fx.upHang = true;
    fireEvent.click(screen.getByTestId('voice-retry'));
    fireEvent.click(await screen.findByTestId('voice-cancel'));
    await act(async () => {
      fx.upOpen?.();
    });
    await sleep(30);
    expect(call, '没上传').not.toHaveBeenCalled();
    expect(writer.insert, '只有写不进的那一次占位').toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('voice-work')).toBeNull();
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

  it('前台上传中切页：中止上传、不写库；回到有“＋”的页（重挂）不出“已记下”', async () => {
    let hang!: () => void;
    const writer = firstFails();
    const { call, session, unmount } = setup({ writer, call: () => new Promise((ok) => (hang = () => ok(VOICE_OK))) });
    await toKept();
    fireEvent.click(screen.getByTestId('voice-retry'));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      hang();
    });
    await sleep(30);
    expect(writer.insert, '没再写库').toHaveBeenCalledTimes(1);
    expect(logged(/^voice attempt \d+ stale at=send$/)).toBe(true);
    setup({ session });
    await sleep(10);
    expect(screen.queryByTestId('type-notice')).toBeNull();
    expect(screen.queryByTestId('voice-notice')).toBeNull();
  });

  it('前台上传中切页：升级中心的 busy 当场放开（这一次已经取消，没有要保住的）', async () => {
    let hang!: () => void;
    const { call, unmount } = setup({ writer: firstFails(), call: () => new Promise((ok) => (hang = () => ok(VOICE_OK))) });
    await holdDown();
    expect(fx.busy, '录着').toEqual(['recording']);
    await release();
    await screen.findByTestId('voice-retry');
    fireEvent.click(screen.getByTestId('voice-retry'));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(fx.busy, '上传中占着').toEqual(['recording']);
    unmount();
    expect(fx.busy, '切页取消：放开').toEqual([]);
    await act(async () => {
      hang();
    });
  });

  /** 写入口桩：第一次写（松手先存的那一条）先卡住，测试里放开；之后照常 */
  const firstHangs = () => {
    const gate = { open: () => undefined as void };
    const writer: WriterMock = { insert: vi.fn<Writer['insert']>(async () => OK), patch: vi.fn<Writer['patch']>(async () => OK) };
    writer.insert.mockImplementationOnce(() => new Promise<WriteResult>((ok) => (gate.open = () => ok(OK))));
    return { gate, writer };
  };

  it('已经开始写库时切页：照常存完、不撤；回到有“＋”的页出“已记下”，busy 存完、后台整理完才放开', async () => {
    const { gate, writer } = firstHangs();
    const session = createVoiceSession({ callVoice: async () => VOICE_OK, writer, online: () => true });
    const { unmount } = setup({ session });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    unmount();
    expect(logged(/^voice host detach status=organizing cancel=0$/)).toBe(true);
    expect(fx.busy, '写库中：占着').toEqual(['recording']);
    await act(async () => {
      gate.open();
    });
    setup({ session });
    expect((await screen.findByTestId('type-notice')).textContent).toContain('已记下');
    expect(logged(/^voice attempt \d+ drop by=/)).toBe(false);
    await waitFor(() => expect(logged(/^voice tidy path=pending out=replaced /)).toBe(true));
    await waitFor(() => expect(fx.busy, '存完、整理完放开').toEqual([]));
  });

  it('已经开始写库后这一次被作废（dispose 等任何 drop）：照样落地、出“已记下”，状态不卡在“正在整理”（整块评审第 7 条：开始写库的一定落地）', async () => {
    const { gate, writer } = firstHangs();
    const session = createVoiceSession({ callVoice: async () => VOICE_OK, writer, online: () => true });
    setup({ session });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    act(() => session.dispose());
    expect(logged(/^voice attempt \d+ drop by=dispose$/)).toBe(true);
    await act(async () => {
      gate.open();
    });
    expect(session.view().status, '收了尾（不卡在 organizing）').toBe('saved');
    expect((await screen.findByTestId('type-notice')).textContent).toContain('已记下');
  });

  // 原“手机自带识别那一路等 AI 时切页：AI 请求当场中止”删掉：11-18 起识别这一路一律先按本机规则存、AI 后台整理（语音整块评审第 10 条），
  // 没有“等 AI 时切页”这一步了；切页后后台照样整理见“识别主路”组
  // 评审第 3、7 条：后台遇到要先问的（过去的月日）不当场弹确认行，结果跟着占位留下；点重试直接用（不再调 AI），出确认行，选完才定占位的去留
  it('停在确认行（过去的月日，R-166）：busy 照样占着，自动重新载入不会把等着选的那一条丢掉；选完才放开（第二轮复查续第 3 条）', async () => {
    const past = { ...ITEM, title: '交房租', due: '2026-10-30', date_basis: 'md', confirm: { past: '2026-10-30', next: '2027-10-30' } };
    const { writer, call, session } = setup({ call: async () => ({ ...VOICE_OK, transcript: '10 月 30 号交房租', items: [past] }) });
    await holdDown();
    await release();
    await waitFor(() => expect(logged(/^voice tidy path=pending out=skip_confirm /)).toBe(true));
    const ph = writer.insert.mock.calls[0]?.[1] as { id: string };
    expect(session.pending.box.getState()).toEqual({ [ph.id]: 'failed' });
    await act(async () => void (await session.retryPending(ph.id)));
    expect(logged(/^voice pending retry bytes=2000 res=1$/)).toBe(true);
    const row = await screen.findByTestId('type-confirm');
    expect(call, '重试用留着的结果，不再调 AI').toHaveBeenCalledTimes(1);
    expect(fx.busy, '确认行出着：占着').toEqual(['recording']);
    expect(writer.insert, '还没选：只有占位').toHaveBeenCalledTimes(1);
    const pastBtn = row.querySelector('button');
    if (!pastBtn) throw new Error('确认行没有按钮');
    fireEvent.click(pastBtn);
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(logged(/^voice pending settle out=saved$/)).toBe(true));
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

  it('“再说一次”：和按住同一条路（开录音器），面板直接是锁定的样子（取消 / 记下），点“记下”先存、整段上传、换成 AI 的', async () => {
    const writer = firstFails();
    const { call } = setup({ writer });
    await toKept();
    fireEvent.click(await screen.findByTestId('voice-again'));
    await sleep(30);
    expect(fx.starts, '第二次开了录音器').toBe(2);
    const panel = await screen.findByTestId('rec-panel');
    expect(panel.dataset['status']).toBe('recording');
    expect(panel.dataset['locked'], '锁定的样子').toBe('');
    expect(panel.textContent).toContain('说完点“记下”');
    expect(logged(/^voice again start online=1 mic=granted route=rec gm=unsup$/)).toBe(true);
    fireEvent.click(screen.getByTestId('rec-done'));
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(3));
    expect(titles(writer).slice(1)).toEqual(['语音记录 · 整理中', '买猫砂']);
    expect(call, '第一次占位存不上没上传').toHaveBeenCalledTimes(1);
  });

  it('“再说一次”时 AI 已经关了：同样当场提示“语音暂时用不了”，不开麦克风', async () => {
    const { session } = setup({ writer: firstFails() });
    await toKept();
    await screen.findByTestId('voice-again');
    collection('settings').clear();
    await sleep(10); // 关掉 AI 以后界面重渲染、把最新的 aiOn 交给控制器
    fireEvent.click(screen.getByTestId('voice-again'));
    expect((await screen.findByTestId('voice-notice')).dataset['note']).toBe('ai_off');
    expect(fx.starts).toBe(1);
    expect(session.view().capturing).toBe(false);
  });

  it('“重试”连点两下：只送一次', async () => {
    const writer = firstFails();
    const { call } = setup({ writer });
    await toKept();
    const retry = screen.getByTestId('voice-retry');
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(2));
    await sleep(30);
    expect(call).toHaveBeenCalledTimes(1);
    expect(writer.insert).toHaveBeenCalledTimes(2);
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

  it('按下时定的挡不挡，满 350 ms 照用（中间额度刷新成用完，这一次照样录）', async () => {
    setup();
    await sleep(10);
    fx.quotaOut = true;
    await holdDown();
    expect(fx.starts, '按下时额度没用完：录音').toBe(1);
    // gm=unsup：这几组不挂 Gemini 实时转写（同 jsdom 没有 AudioWorklet），实时转写那一组打开
    expect(logged(/^voice hold start .* route=rec gm=unsup$/)).toBe(true);
  });
});

// 11-24 起只有一条路：录音 + Gemini 实时转写边说边出字（负责人选“三条出字的路合成一条”）。松手不等定稿，已出的字当场按本机规则存，
// 后台把这段录音交 ai-voice 整理（负责人 11-24 选“松手马上用已出的字存”；不再调 ai-parse，一句话只扣一次），没出字照旧上传录音。承接 R-456 的先存和后台整理
describe('实时转写：边说边出字、先存、AI 后台整理', () => {
  const TWO = { ...VOICE_OK, transcript: '买牛奶，明天下午三点开会', items: [{ ...ITEM, title: '买牛奶' }, { ...ITEM, kind: 'event', title: '开会', date: '2026-11-03', time: '15:00' }] };
  /** 写进去的第几条的 id、标题 */
  const ins = (w: { insert: { mock: { calls: unknown[][] } } }, i: number) => w.insert.mock.calls[i]?.[1] as { id: string; title: string };
  /** AI 那一步先卡住，测试里放开 */
  const held = () => {
    const box: { open: (v: unknown) => void } = { open: () => undefined };
    const call = () => new Promise((ok) => (box.open = ok));
    return { box, call };
  };
  beforeEach(() => {
    fx.gem = true;
  });

  /** 后台整理走 ai-voice（callVoice）：先卡住，测试里放开；ai-parse 不该被调（callAi 记着） */
  const heldAi = () => {
    const h = held();
    const never = vi.fn(async () => Promise.reject(new Error('不该调 ai-parse')));
    return { box: h.box, call: h.call, callAi: never as unknown as CallAi, never };
  };
  /** 往面板出字（会话的 onText） */
  const say = async (t: string): Promise<void> => {
    await act(async () => fx.gemOpts?.onText(t));
  };

  it('按住时面板上实时出字（深底大框在计时上方），声波是真实电平；松手不等定稿、不等 AI 当场按本机规则存，出“已记下”、busy 放开；录音在后台交 ai-voice 一次，不调 ai-parse', async () => {
    const ai = heldAi();
    const { writer, call, session } = setup({ call: ai.call, callAi: ai.callAi });
    await holdDown();
    expect(logged(/^voice hold start online=1 mic=granted route=rec gm=on$/)).toBe(true);
    expect(fx.starts, '录音器照旧开着（失败时整段上传兜底）').toBe(1);
    expect(fx.gemOpens, '开了一个会话').toBe(1);
    expect(session.level(), '声波用采音量到的真实电平').toBe(0.5);
    await say('买牛');
    expect(screen.getByTestId('rec-live').textContent).toBe('买牛');
    await say('买牛奶');
    expect(screen.getByTestId('rec-live').textContent).toBe('买牛奶');
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    expect(ins(writer, 0).title).toBe('买牛奶');
    expect((await screen.findByTestId('type-notice')).textContent).toContain('已记下：买牛奶');
    expect(screen.queryByTestId('voice-work'), '不转圈').toBeNull();
    expect(live?.view().status).toBe('saved');
    expect(fx.busy, '后台整理期间不占 busy').toEqual([]);
    expect(call, '录音在后台交 ai-voice 一次').toHaveBeenCalledTimes(1);
    expect(ai.never, '不调 ai-parse（一句话只扣一次）').not.toHaveBeenCalled();
    expect(logged(/^voice saved path=text out=ok n=1 bytes=2000 ms=\d+$/)).toBe(true);
    expect(log.some((l) => l.includes('买牛奶')), '不记说的内容').toBe(false);
    await act(async () => ai.box.open({ ...VOICE_OK, transcript: '买牛奶', items: [{ ...ITEM, title: '买牛奶' }] }));
    await waitFor(() => expect(logged(/^voice tidy path=text out=same ms=\d+ total_ms=\d+$/)).toBe(true));
  });

  it('没出字（会话收尾交出空串）：先存占位、这段录音整段上传，AI 回来换掉；日志 fallback why=empty', async () => {
    fx.gemSay = '';
    const { writer, call } = setup();
    await holdDown();
    expect(screen.queryByTestId('rec-live')).toBeNull();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(2));
    expect(call, '整段上传').toHaveBeenCalledTimes(1);
    expect([ins(writer, 0).title, ins(writer, 1).title]).toEqual(['语音记录 · 整理中', '买猫砂']);
    expect(logged(/^voice gem fallback why=empty$/)).toBe(true);
  });

  // 负责人 11-24：额度是按下后换令牌才知道用完的——令牌回“今天用完”时当场停录、提示，记下剩 0 次，下次按下直接挡
  it('令牌回了今天用完：当场停录（关麦克风）、不上传，提示“语音暂时用不了”和几点恢复；下次按下不开麦克风、直接提示', async () => {
    fx.gemTok = { ok: false, why: 'quota_out' };
    const { writer, call } = setup();
    await holdDown();
    await sleep(20);
    expect(fx.signal?.aborted, '录音器收到取消（关麦克风）').toBe(true);
    expect(live?.view().capturing, '面板收起').toBe(false);
    const note = await screen.findByTestId('voice-notice');
    expect(note.dataset['note']).toBe('quota');
    expect(note.textContent).toContain('语音暂时用不了');
    expect(logged(/^voice rec stop_now why=quota_out status=recording$/)).toBe(true);
    await release();
    await sleep(20);
    expect(call, '不上传').not.toHaveBeenCalled();
    expect(writer.insert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('voice-notice-close'));
    await holdDown();
    expect(fx.starts, '第二次不开录音器').toBe(1);
    expect((await screen.findByTestId('voice-notice')).dataset['note']).toBe('quota');
    expect(logged(/^voice hold start .* route=quota gm=on$/)).toBe(true);
    await release();
  });

  it('AI 回来拆得不一样：先存 AI 的、再撤先存的，提示条写“AI 已整理”，“全部撤销”撤的是 AI 那两条；换的那一下占住 busy', async () => {
    fx.gemSay = '买牛奶开会';
    const ai = heldAi();
    const { writer } = setup({ call: ai.call, callAi: ai.callAi });
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
    await waitFor(() => expect(logged(/^voice tidy path=text out=replaced ms=\d+ total_ms=\d+$/)).toBe(true));
    // 11-25：换成了记每条日子离今天差几天（AI 那两条：待办没日子 n、日程明天 +1），不记日期原值
    expect(logged(/^voice tidy days local=(?:n|[+-]\d+)(?:,(?:n|[+-]\d+))* ai=n,\+1$/)).toBe(true);
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

  it('提示条关掉以后 AI 才回来：库里照样换，提示条不再弹出来', async () => {
    fx.gemSay = '买牛奶开会';
    const ai = heldAi();
    const { writer, session } = setup({ call: ai.call, callAi: ai.callAi });
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

  it('AI 回来之前用户已经撤销了这一批：不替换（不再写库），日志 out=skip_gone', async () => {
    fx.gemSay = '买牛奶开会';
    const ai = heldAi();
    const { writer } = setup({ call: ai.call, callAi: ai.callAi });
    await holdDown();
    await release();
    fireEvent.click(await screen.findByText('撤销'));
    await waitFor(() => expect(writer.patch).toHaveBeenCalledTimes(1));
    await act(async () => ai.box.open(TWO));
    await waitFor(() => expect(logged(/^voice tidy path=text out=skip_gone ms=\d+ total_ms=\d+$/)).toBe(true));
    expect(writer.insert).toHaveBeenCalledTimes(1);
  });

  // 负责人 11-24 选第 4 条“连着说两句时照样换（推荐）”：只要那一条用户没动过，第一句也在后台换成 AI 整理过的
  it('AI 回来之前又按住说了新的一句：上一句照样换成 AI 的（那一条没动过），提示条不动；每次说话都新开一个会话', async () => {
    fx.gemSay = '买牛奶开会';
    const ai = heldAi();
    const { writer } = setup({ call: ai.call, callAi: ai.callAi });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    const first = ins(writer, 0).id;
    const firstBox = ai.box.open;
    const before = fx.gemOpens;
    await holdDown();
    expect(fx.gemOpens, '新开了一个会话').toBe(before + 1);
    await act(async () => firstBox(TWO));
    await waitFor(() => expect(logged(/^voice tidy path=text out=replaced /)).toBe(true));
    expect([1, 2].map((i) => ins(writer, i).title), 'AI 那两条存上').toEqual(['买牛奶', '开会']);
    expect(writer.patch.mock.calls.map((c) => c[1]), '撤了上一句先存的那条').toEqual([first]);
    await release();
  });

  it('AI 失败：先存的留着，不出“重试 / 再说一次”', async () => {
    const { writer } = setup({ call: async () => ({ ai_failed: true, reason: 'error' }) });
    await holdDown();
    await release();
    await waitFor(() => expect(logged(/^voice tidy path=text out=failed_\w+ ms=\d+ total_ms=\d+$/)).toBe(true));
    expect(writer.insert).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('voice-notice'), '不让人重说').toBeNull();
    expect(screen.getByTestId('type-notice').textContent).toContain('已记下：买牛奶');
  });

  it('先存以后切页：后台整理不取消，照样换掉', async () => {
    fx.gemSay = '买牛奶开会';
    const ai = heldAi();
    const { writer, unmount } = setup({ call: ai.call, callAi: ai.callAi });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    unmount();
    expect(logged(/^voice host detach status=saved cancel=0$/)).toBe(true);
    await act(async () => ai.box.open(TWO));
    await waitFor(() => expect(logged(/out=replaced/)).toBe(true));
    expect(writer.insert).toHaveBeenCalledTimes(3);
  });

  it('松手后还没存好（会话还在要回最后半块音）时切走页面：这一次作废，不存、不上传，字清掉（R-404：存好之前那一下照旧中止）', async () => {
    fx.gemHang = true;
    const { writer, call, unmount } = setup();
    await holdDown();
    await say('买牛奶');
    await release();
    expect(await screen.findByTestId('voice-work')).toBeTruthy();
    unmount();
    expect(logged(/^voice attempt \d+ drop by=page_leave$/)).toBe(true);
    await act(async () => fx.gemOpen?.());
    await sleep(30);
    expect(writer.insert).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(live?.view().live, '字清掉').toBe('');
  });

  it('替换进行中：提示条上的按钮全部禁用，点“撤销”不撤', async () => {
    fx.gemSay = '买牛奶开会';
    const ai = heldAi();
    const { writer } = setup({ call: ai.call, callAi: ai.callAi });
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

  it('在别处改过先存的那条以后 AI 才回来：不换，日志 out=skip_edited', async () => {
    fx.gemSay = '买牛奶开会';
    const ai = heldAi();
    const { writer } = setup({ call: ai.call, callAi: ai.callAi });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    const first = ins(writer, 0);
    const table = String(writer.insert.mock.calls[0]?.[0]);
    collection(table).upsert([{ ...first, updated_at: NOW + 1000, deleted_at: null, done_at: null } as never]);
    await act(async () => ai.box.open(TWO));
    await waitFor(() => expect(logged(/^voice tidy path=text out=skip_edited ms=\d+ total_ms=\d+$/)).toBe(true));
    expect(writer.insert).toHaveBeenCalledTimes(1);
  });

  it('松手后超过 20 秒 AI 才回来：不换，日志 out=skip_late', async () => {
    fx.gemSay = '买牛奶开会';
    const ai = heldAi();
    const { writer } = setup({ call: ai.call, callAi: ai.callAi });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    const real = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => real() + LIVE_LATE_MS + 1000);
    await act(async () => ai.box.open(TWO));
    await waitFor(() => expect(logged(/^voice tidy path=text out=skip_late ms=\d+ total_ms=\d+$/)).toBe(true));
    expect(writer.insert).toHaveBeenCalledTimes(1);
    expect(writer.patch).not.toHaveBeenCalled();
  });
});

// 负责人 11-24：“我最想要的是说完马上记录，不要等那么久”，选“先记一条‘整理中’（推荐）”：整段上传那一下松手先存占位，AI 回来换掉（data/voice-pending.ts）
describe('整段上传：松手先存“语音记录 · 整理中”，AI 回来换掉', () => {
  const PH = '语音记录 · 整理中';
  /** 写进去的第几条（表、整行） */
  const ins = (w: WriterMock, i: number) => w.insert.mock.calls[i]?.[1] as { id: string; title: string; due: string | null; source: string };
  /** 写入口桩：照样写进本机集合（占位那一条“动没动过”看集合里的样子） */
  const mirrored = (): WriterMock => ({
    insert: vi.fn<Writer['insert']>(async (t, data) => {
      collection(t as 'todos').upsert([{ deleted_at: null, done: false, ...data } as Parameters<ReturnType<typeof collection>['upsert']>[0][number]]);
      return OK;
    }),
    patch: vi.fn<Writer['patch']>(async (t, id, data) => {
      const r = collection(t as 'todos').get(id) as Record<string, unknown> | undefined;
      if (r) collection(t as 'todos').upsert([{ ...r, ...data, id }]);
      return OK;
    }),
  });
  /** ai-voice 一次一次卡住，测试里按顺序放开 */
  const heldCalls = () => {
    const open: ((v: unknown) => void)[] = [];
    return { open, call: () => new Promise((ok) => open.push(ok)) };
  };
  const patchOf = (w: WriterMock, id: string) => w.patch.mock.calls.filter((c) => c[1] === id).map((c) => c[2]);

  it('松手当场存一条今天的待办“语音记录 · 整理中”：面板收起、提示条“已记下”、不转圈；AI 回来换成拆出的条目、撤掉占位，提示条写“AI 已整理”', async () => {
    const h = heldCalls();
    const writer = mirrored();
    const { call, session } = setup({ writer, call: h.call });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    const ph = ins(writer, 0);
    expect(ph).toMatchObject({ title: PH, due: '2026-11-02', source: 'voice' });
    expect((await screen.findByTestId('type-notice')).textContent).toContain(`已记下：${PH}`);
    expect(screen.queryByTestId('rec-panel')).toBeNull();
    expect(screen.queryByTestId('voice-work'), '不转圈').toBeNull();
    expect(session.view().status).toBe('saved');
    expect(fx.busy, '后台等 AI 占着 busy（评审第 5 条）').toEqual(['recording']);
    expect(call, '录音在后台上传').toHaveBeenCalledTimes(1);
    expect(session.pending.box.getState()).toEqual({ [ph.id]: 'tidying' });
    expect(logged(/^voice saved path=pending out=ok n=1 bytes=2000 ms=\d+$/)).toBe(true);
    await act(async () => h.open[0]?.(VOICE_OK));
    await waitFor(() => expect(logged(/^voice tidy path=pending out=replaced ms=\d+ total_ms=\d+$/)).toBe(true));
    expect(ins(writer, 1).title).toBe('买猫砂');
    expect(patchOf(writer, ph.id), '撤掉了占位').toEqual([expect.objectContaining({ undone: true })]);
    const notice = await screen.findByTestId('type-notice');
    expect(notice.textContent).toContain('已记下：买猫砂');
    expect(notice.textContent).toContain('AI 已整理');
    expect(session.pending.box.getState(), '录音不再留').toEqual({});
    expect(log.some((l) => l.includes('买猫砂')), '不记说的内容').toBe(false);
  });

  it('AI 说没听到说话：撤掉占位、收起提示条，日志 out=dropped', async () => {
    const writer = mirrored();
    const { session } = setup({ writer, call: async () => ({ intent: 'record', confidence: 1, items: [], quota_left: 3, transcript: '' }) });
    await holdDown();
    await release();
    await waitFor(() => expect(logged(/^voice tidy path=pending out=dropped /)).toBe(true));
    const ph = ins(writer, 0);
    expect(writer.insert, '没有别的条目').toHaveBeenCalledTimes(1);
    expect(patchOf(writer, ph.id)).toEqual([expect.objectContaining({ undone: true })]);
    await waitFor(() => expect(screen.queryByTestId('type-notice')).toBeNull());
    expect(session.pending.box.getState()).toEqual({});
  });

  it('AI 没回应：占位留着、改名“语音记录 · 没整理成”，录音留着；点“重试”前台再传同一段，记下了就撤掉占位', async () => {
    let n = 0;
    const writer = mirrored();
    const { call, session } = setup({
      writer,
      call: async () => {
        n += 1;
        return n === 1 ? { ai_failed: true, reason: 'error' } : VOICE_OK;
      },
    });
    await holdDown();
    await release();
    await waitFor(() => expect(logged(/^voice tidy path=pending out=failed_error /)).toBe(true));
    const ph = ins(writer, 0);
    expect(patchOf(writer, ph.id)).toEqual([expect.objectContaining({ title: '语音记录 · 没整理成' })]);
    expect(session.pending.box.getState()).toEqual({ [ph.id]: 'failed' });
    expect(screen.queryByTestId('voice-notice'), '后台失败不弹提示条（占位的标题说明了）').toBeNull();
    const first = (call.mock.calls[0]?.[0] as { audio: Blob }).audio;
    let out = '';
    await act(async () => {
      out = await session.retryPending(ph.id);
    });
    expect(out).toBe('started');
    await waitFor(() => expect(logged(/^voice pending settle out=saved$/)).toBe(true));
    expect((call.mock.calls[1]?.[0] as { audio: Blob }).audio, '同一段录音').toBe(first);
    expect(ins(writer, 1).title).toBe('买猫砂');
    await waitFor(() => expect(patchOf(writer, ph.id)).toHaveLength(2));
    expect(patchOf(writer, ph.id)[1]).toMatchObject({ undone: true });
    expect(session.pending.box.getState()).toEqual({});
    expect(logged(/^voice pending retry bytes=2000$/)).toBe(true);
  });

  it('AI 回来之前用户撤销了占位：不再写库，录音不留，日志 out=skip_gone', async () => {
    const h = heldCalls();
    const writer = mirrored();
    const { session } = setup({ writer, call: h.call });
    await holdDown();
    await release();
    fireEvent.click(await screen.findByText('撤销'));
    await waitFor(() => expect(writer.patch).toHaveBeenCalledTimes(1));
    await act(async () => h.open[0]?.(VOICE_OK));
    await waitFor(() => expect(logged(/^voice tidy path=pending out=skip_gone /)).toBe(true));
    expect(writer.insert).toHaveBeenCalledTimes(1);
    expect(session.pending.box.getState()).toEqual({});
  });

  it('AI 回来之前又按住说了一句：上一句的占位照样换掉（只看那一条动没动过），两句各存各的', async () => {
    const h = heldCalls();
    const writer = mirrored();
    setup({ writer, call: h.call });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(2));
    const [a, b] = [ins(writer, 0), ins(writer, 1)];
    expect([a.title, b.title]).toEqual([PH, PH]);
    await act(async () => h.open[0]?.(VOICE_OK));
    await waitFor(() => expect(logged(/out=replaced/)).toBe(true));
    expect(patchOf(writer, a.id)).toEqual([expect.objectContaining({ undone: true })]);
    expect(patchOf(writer, b.id), '第二句的占位还在等').toEqual([]);
    expect((await screen.findByTestId('type-notice')).textContent, '提示条照旧是第二句的').toContain(`已记下：${PH}`);
  });

  it('占位存好以后切页：后台照样整理、换掉', async () => {
    const h = heldCalls();
    const writer = mirrored();
    const { unmount } = setup({ writer, call: h.call });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    unmount();
    expect(logged(/^voice host detach status=saved cancel=0$/)).toBe(true);
    await act(async () => h.open[0]?.(VOICE_OK));
    await waitFor(() => expect(logged(/out=replaced/)).toBe(true));
    expect(ins(writer, 1).title).toBe('买猫砂');
  });

  it('Gemini 没出字退回整段上传：同样先存占位', async () => {
    fx.gem = true;
    fx.gemSay = '';
    const h = heldCalls();
    const writer = mirrored();
    setup({ writer, call: h.call });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    expect(ins(writer, 0).title).toBe(PH);
    expect(logged(/^voice gem fallback why=empty$/)).toBe(true);
    await act(async () => h.open[0]?.(VOICE_OK));
    await waitFor(() => expect(logged(/out=replaced/)).toBe(true));
  });

  it('占位存不上（写不进本机）：不在前台等 AI，录音留着、提示条给“重试”；点重试前台上传这段录音、记下', async () => {
    let n = 0;
    const writer: WriterMock = {
      insert: vi.fn<Writer['insert']>(async (): Promise<WriteResult> => {
        n += 1;
        return n === 1 ? { ok: false, reason: 'local_unavailable' } : OK;
      }),
      patch: vi.fn<Writer['patch']>(async () => OK),
    };
    const { call } = setup({ writer });
    await holdDown();
    await release();
    const note = await screen.findByTestId('voice-notice');
    expect(note.dataset['note']).toBe('ai_failed');
    expect(call, '没存上就不上传').not.toHaveBeenCalled();
    expect(logged(/^voice rec keep bytes=2000$/)).toBe(true);
    fireEvent.click(screen.getByTestId('voice-retry'));
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(2));
    expect(ins(writer, 1).title).toBe('买猫砂');
    expect((await screen.findByTestId('type-notice')).textContent).toContain('已记下：买猫砂');
  });

  it('评审第 5 条：占位那一路的后台整理整段占住升级中心的 busy（被自动重新载入打断会丢结果、又多扣一次），整理完放开', async () => {
    const h = heldCalls();
    const writer = mirrored();
    setup({ writer, call: h.call });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    expect(fx.busy, '等 AI 期间占着').toEqual(['recording']);
    await act(async () => h.open[0]?.(VOICE_OK));
    await waitFor(() => expect(logged(/out=replaced/)).toBe(true));
    expect(fx.busy, '整理完放开').toEqual([]);
  });

  it('评审第 3 条：换的那一下锁被占着（skip_busy，正在撤销下一句）：稍后再试一次，不算失败', async () => {
    const h = heldCalls();
    const writer = mirrored();
    const { session } = setup({ writer, call: h.call });
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(1));
    await holdDown();
    await release();
    await waitFor(() => expect(writer.insert).toHaveBeenCalledTimes(2));
    const first = ins(writer, 0).id;
    // 第二句的提示条上逐条撤销（展开后那一条的“撤销”，提示条不收起），写库卡住：这一刻锁被占着
    const gate: { open: () => void } = { open: () => undefined };
    writer.patch.mockImplementationOnce(() => new Promise<WriteResult>((ok) => (gate.open = () => ok(OK))));
    void session.batch.undoOne(ins(writer, 1).id);
    await act(async () => h.open[0]?.(VOICE_OK));
    await sleep(50);
    expect(logged(/^voice tidy busy_retry$/)).toBe(true);
    expect(session.pending.box.getState()[first], '锁占着：不算失败').toBe('tidying');
    await act(async () => gate.open());
    await waitFor(() => expect(logged(/^voice tidy path=pending out=replaced /)).toBe(true), { timeout: 3000 });
    expect(session.pending.box.getState()[first]).toBeUndefined();
  });
});
