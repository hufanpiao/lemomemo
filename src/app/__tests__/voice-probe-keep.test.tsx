// R-68 探测页结果留底（R-382：录到一半被踢回登录页，结果全丢）：每段结果出来就存、重进页面显示、“Clear results”删；
// 只存白名单字段（录音不存）；登出清库的几条删键规则都碰不到这个键；正式版读写都不做
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Probe from '../../platform/voice-probe.ts';
import { clearLogQueue, clearOtherLogQueues } from '../../platform/log-store.ts';
import { KEEP_KEY, KEEP_MAX, keepReply, loadKept, saveKept, type KeptSegment } from '../dev/voice-probe-keep.ts';

const stop = vi.fn(async () => ({ blob: new Blob([new Uint8Array([7, 7, 7])], { type: 'audio/webm' }), mime: 'audio/webm;codecs=opus', ms: 2300 }));
const upload = vi.fn();
const start = vi.fn();
vi.mock('../../platform/voice-probe.ts', async (orig) => ({
  ...(await orig<typeof Probe>()),
  startRecording: (...a: unknown[]) => start(...a),
  uploadProbe: (...a: unknown[]) => upload(...a),
  supportedTypes: () => [],
}));
const { default: VoiceProbe } = await import('../dev/VoiceProbe.tsx');

const reply = (label: string, transcript: string): Probe.ProbeReply => ({
  status: 200,
  model: 'gemini-x',
  mime: label,
  raw_type: label,
  bytes: 3,
  gemini_http: 200,
  gemini_ms: 800,
  total_ms: 900,
  result: 'ok',
  transcript,
  error: null,
  client_ms: 1000,
});

beforeEach(() => {
  localStorage.clear();
  HTMLElement.prototype.setPointerCapture = vi.fn();
  start.mockImplementation(async () => ({ stop, cancel: vi.fn() }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  localStorage.clear();
});

async function recordOnce(): Promise<void> {
  const hold = screen.getByTestId('probe-hold');
  await act(async () => {
    fireEvent.pointerDown(hold, { pointerId: 1 });
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.pointerUp(hold, { pointerId: 1 });
    await new Promise((r) => setTimeout(r, 0));
  });
}
const kept = (): KeptSegment[] => JSON.parse(localStorage.getItem(KEEP_KEY) ?? '[]') as KeptSegment[];

describe('探测页结果留底', () => {
  it('第一种标注一回来就存（第二种还在传），只存白名单字段，录音本身不存', async () => {
    let second!: (r: Probe.ProbeReply) => void;
    upload.mockResolvedValueOnce(reply('audio/webm', '今天天气很好')).mockImplementationOnce(() => new Promise((r) => (second = r)));
    render(<VoiceProbe />);
    await recordOnce();
    expect(kept()).toEqual([
      {
        n: 1,
        recorder: 'audio/webm;codecs=opus',
        size: 3,
        ms: 2300,
        replies: [{ label: 'audio/webm', status: 200, result: 'ok', gemini_http: 200, bytes: 3, gemini_ms: 800, total_ms: 900, client_ms: 1000, transcript: '今天天气很好' }],
      },
    ]);
    const raw = localStorage.getItem(KEEP_KEY)!;
    for (const no of ['gemini-x', 'raw_type', 'model', 'error', 'blob']) expect(raw).not.toContain(no);
    await act(async () => {
      second(reply('audio/webm;codecs=opus', '第二种'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(kept()[0]!.replies.map((r) => r.transcript)).toEqual(['今天天气很好', '第二种']);
  });

  it('被踢走（卸载）后重新进页面：之前的结果显示出来，编号接着排', async () => {
    upload.mockResolvedValue(reply('audio/webm', '固定测试句一'));
    const first = render(<VoiceProbe />);
    await recordOnce();
    first.unmount();
    render(<VoiceProbe />);
    const list = screen.getByTestId('probe-results');
    expect(list.textContent).toContain('固定测试句一');
    expect(list.textContent).toContain('saved earlier');
    expect(list.textContent).toContain('HTTP 200');
    await recordOnce();
    expect(kept().map((s) => s.n)).toEqual([2, 1]);
  });

  it('“Clear results”：列表清空、键删掉；没有结果时不显示按钮', async () => {
    saveKept([{ n: 1, recorder: 'audio/mp4', size: 10, ms: 1000, replies: [keepReply('audio/mp4', reply('audio/mp4', '句子'))] }]);
    render(<VoiceProbe />);
    fireEvent.click(screen.getByTestId('probe-clear'));
    expect(localStorage.getItem(KEEP_KEY)).toBeNull();
    expect(screen.getByTestId('probe-results').textContent).toBe('');
    expect(screen.queryByTestId('probe-clear')).toBeNull();
  });

  it('坏数据、多余字段读出来都过白名单；最多留 KEEP_MAX 段', () => {
    localStorage.setItem(KEEP_KEY, '{bad');
    expect(loadKept()).toEqual([]);
    localStorage.setItem(KEEP_KEY, JSON.stringify([{ n: 1, recorder: 'a', size: 1, ms: 1, email: 'x@y', replies: [{ label: 'a', status: 200, token: 't', transcript: 's' }] }, 'junk']));
    expect(JSON.stringify(loadKept())).not.toMatch(/email|token/);
    const many = Array.from({ length: KEEP_MAX + 5 }, (_, i) => ({ n: i + 1, recorder: 'a', size: 1, ms: 1, replies: [keepReply('a', reply('a', 's'))] }));
    saveKept(many);
    expect(kept()).toHaveLength(KEEP_MAX);
  });

  it('正式版：读写都不做', () => {
    vi.stubEnv('MODE', 'production');
    saveKept([{ n: 1, recorder: 'a', size: 1, ms: 1, replies: [keepReply('a', reply('a', 's'))] }]);
    expect(localStorage.getItem(KEEP_KEY)).toBeNull();
    vi.unstubAllEnvs();
    saveKept([{ n: 1, recorder: 'a', size: 1, ms: 1, replies: [keepReply('a', reply('a', 's'))] }]);
    vi.stubEnv('MODE', 'production');
    expect(loadKept()).toEqual([]);
  });
});

describe('登出清库碰不到留底的键', () => {
  it('日志队列的两种清法都不删它', () => {
    localStorage.setItem(KEEP_KEY, '[]x');
    localStorage.setItem('lemo.logq.u1', '[]');
    clearLogQueue(null);
    clearOtherLogQueues('u2');
    expect(localStorage.getItem('lemo.logq.u1')).toBeNull();
    expect(localStorage.getItem(KEEP_KEY)).toBe('[]x');
  });

  it('会话键的两条匹配规则（session.ts、session-store.ts）都不匹配它', () => {
    const root = resolve(__dirname, '../..');
    const sessionRe = readFileSync(join(root, 'platform/session.ts'), 'utf8').match(/const KEY_RE = (\/.+\/);/)![1]!;
    const oldRe = readFileSync(join(root, 'platform/session-store.ts'), 'utf8').match(/const OLD_SESSION_KEY = (\/.+\/);/)![1]!;
    for (const re of [sessionRe, oldRe]) {
      const r = new RegExp(re.slice(1, -1));
      expect(r.test('sb-x-auth-token')).toBe(true);   // 规则本身还认得会话键（防止正则没抓对）
      expect(r.test(KEEP_KEY)).toBe(false);
    }
    expect(KEEP_KEY.startsWith('lemo.logq.')).toBe(false);
  });

  it('src 里（测试除外）没有整库清 localStorage 的写法', () => {
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) {
          if (n !== '__tests__') walk(p);
        } else if (/\.tsx?$/.test(n) && /localStorage\(?\)?\.clear\(|Storage\(\)\.clear\(/.test(readFileSync(p, 'utf8'))) hits.push(p);
      }
    };
    walk(resolve(__dirname, '../..'));
    expect(hits).toEqual([]);
  });
});
