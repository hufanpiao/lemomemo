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
import { hold, type HoldPointer } from '../data/hold-input.ts';
import { HOLD_MS } from '../data/record-logic.ts';
import { resetVoiceForTest } from '../hooks/useVoice.ts';
import { RecordHost } from '../ui/RecordHost.tsx';

const SID = 'sid-v';
vi.mock('../../../platform/session.ts', async (orig) => ({ ...(await orig<typeof Session>()), readSessionId: () => SID }));

const fx = vi.hoisted(() => ({
  starts: 0,
  autoStop: null as null | (() => void),
  stops: 0,
  speech: [] as { lang: string; end: (r: { ok: true; text: string }) => void; cancelled: boolean }[],
}));
vi.mock('../../../platform/recorder.ts', () => ({
  recorderSupported: () => true,
  requestMic: async () => 'granted',
  startRecorder: async (o: { onAutoStop?: () => void }) => {
    fx.starts += 1;
    fx.autoStop = o.onAutoStop ?? null;
    return {
      ok: true,
      rec: {
        elapsed: () => 7000,
        level: () => 0.4,
        stop: async () => {
          fx.stops += 1;
          return { ok: true, auto: false, clip: { blob: new Blob([new Uint8Array(2000)], { type: 'audio/mp4' }), mime: 'audio/mp4', ms: 7000 } };
        },
      },
    };
  },
}));
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

function setup(o: { call?: (...a: unknown[]) => Promise<unknown>; online?: () => boolean } = {}) {
  const writer = { insert: vi.fn<Writer['insert']>(async () => OK), patch: vi.fn<Writer['patch']>(async () => OK) };
  const call = vi.fn(o.call ?? (async () => VOICE_OK));
  render(<RecordHost callVoice={call} writer={writer} online={o.online ?? (() => true)} />);
  return { writer, call };
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
  resetVoiceForTest();
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
