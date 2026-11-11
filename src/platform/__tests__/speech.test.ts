// 手机自带识别的封装（platform/speech.ts）：假的识别器。
// 钉住：同步启动（在用户手势里）、按界面语言、实时出字、结束和错误的归类、取消后不再回调、运行日志不带识别出的字
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RL_SLOT } from '../run-log-api.ts';
import { speechSupported, startSpeech, type SpeechEnd } from '../speech.ts';

class FakeRecognition {
  static made: FakeRecognition[] = [];
  static startThrows: Error | null = null;
  lang = '';
  interimResults = false;
  continuous = false;
  onstart: (() => void) | null = null;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null = null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn(() => {
    if (FakeRecognition.startThrows) throw FakeRecognition.startThrows;
  });
  stop = vi.fn();
  abort = vi.fn();

  constructor() {
    FakeRecognition.made.push(this);
  }
  /** 一次 result 事件：每段 [文字, 是否已定稿] */
  result(segs: [string, boolean][]): void {
    const results = segs.map(([transcript, isFinal]) => Object.assign([{ transcript, confidence: 1 }], { isFinal }));
    this.onresult?.({ results } as unknown as SpeechRecognitionEvent);
  }
  error(code: string): void {
    this.onerror?.({ error: code } as unknown as SpeechRecognitionErrorEvent);
  }
}

const SAID = '明天下午三点开会';
let lines: string[] = [];

function begin(lang: 'zh-CN' | 'ko-KR' = 'zh-CN') {
  const onStart = vi.fn();
  const onText = vi.fn<(text: string) => void>();
  const onEnd = vi.fn<(r: SpeechEnd) => void>();
  const r = startSpeech(lang, { onStart, onText, onEnd }, () => 0);
  if (!r.ok) throw new Error(`没开起来：${r.fail}`);
  const rec = FakeRecognition.made.at(-1);
  if (!rec) throw new Error('没建识别器');
  return { rec, session: r.session, onStart, onText, onEnd };
}

beforeEach(() => {
  FakeRecognition.made = [];
  FakeRecognition.startThrows = null;
  vi.stubGlobal('SpeechRecognition', FakeRecognition);
  lines = [];
  (globalThis as Record<string, unknown>)[RL_SLOT] = { q: [], sink: (l: string) => lines.push(l) };
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>)[RL_SLOT];
});

describe('启动', () => {
  it('同步启动：startSpeech 返回时 start() 已经调过；语言跟界面，实时出字、停顿不断', () => {
    const zh = begin('zh-CN');
    expect(zh.rec.start).toHaveBeenCalledTimes(1);
    expect([zh.rec.lang, zh.rec.interimResults, zh.rec.continuous]).toEqual(['zh-CN', true, true]);
    expect(begin('ko-KR').rec.lang).toBe('ko-KR');
  });

  it('只有 webkitSpeechRecognition 也能用；两个名字都没有：unsupported', () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    expect(speechSupported()).toBe(true);
    expect(begin().rec.start).toHaveBeenCalledTimes(1);

    vi.stubGlobal('webkitSpeechRecognition', undefined);
    expect(speechSupported()).toBe(false);
    expect(startSpeech('zh-CN', { onEnd: vi.fn() })).toEqual({ ok: false, fail: 'unsupported' });
  });

  it('start() 当场抛错：返回 error，不往外抛', () => {
    FakeRecognition.startThrows = new DOMException('x', 'InvalidStateError');
    const onEnd = vi.fn();
    expect(startSpeech('zh-CN', { onEnd }, () => 0)).toEqual({ ok: false, fail: 'error' });
    expect(onEnd).not.toHaveBeenCalled();
    expect(lines).toEqual(['speech fail reason=error type=InvalidStateError ms=0']);
  });

  it('onStart 等 start 事件到了才调，只调一次', () => {
    const s = begin();
    expect(s.onStart).not.toHaveBeenCalled();
    s.rec.onstart?.();
    s.rec.onstart?.();
    expect(s.onStart).toHaveBeenCalledTimes(1);
  });
});

describe('出字和结束', () => {
  it('已定稿的段和没定稿的段按顺序拼成全文', () => {
    const s = begin();
    s.rec.result([['明天下午', true], ['三点', false]]);
    expect(s.onText).toHaveBeenLastCalledWith('明天下午三点');
    s.rec.result([['明天下午', true], ['三点开会', true]]);
    expect(s.onText).toHaveBeenLastCalledWith(SAID);
  });

  it('stop() 要结果：end 到了交出去首尾空白的文字，只交一次', () => {
    const s = begin();
    s.session.stop();
    expect(s.rec.stop).toHaveBeenCalledTimes(1);
    expect(s.rec.abort).not.toHaveBeenCalled();
    s.rec.result([[` ${SAID} `, true]]);
    s.rec.onend?.();
    s.rec.onend?.();
    expect(s.onEnd.mock.calls).toEqual([[{ ok: true, text: SAID }]]);
  });

  it('没调 stop() 识别自己结束：带上已经认出的字', () => {
    const s = begin();
    s.rec.result([['买牛奶', false]]);
    s.rec.onend?.();
    expect(s.onEnd.mock.calls).toEqual([[{ ok: true, text: '买牛奶' }]]);
  });

  it('什么都没认出就结束、或报 no-speech：空串（调用方按“没听清”）', () => {
    const a = begin();
    a.rec.onend?.();
    expect(a.onEnd.mock.calls).toEqual([[{ ok: true, text: '' }]]);

    const b = begin();
    b.rec.error('no-speech');
    expect(b.onEnd).not.toHaveBeenCalled();
    b.rec.onend?.();
    expect(b.onEnd.mock.calls).toEqual([[{ ok: true, text: '' }]]);
  });
});

describe('错误和取消', () => {
  it.each([
    ['not-allowed', 'denied'],
    ['service-not-allowed', 'denied'],
    ['network', 'network'],
    ['audio-capture', 'error'],
    ['language-not-supported', 'error'],
  ])('%s → %s；后面跟着的 end 不再回调', (code, fail) => {
    const s = begin();
    s.rec.error(code);
    s.rec.onend?.();
    expect(s.onEnd.mock.calls).toEqual([[{ ok: false, fail }]]);
  });

  it('cancel() 调 abort()；之后的 result、error、end 都不再回调', () => {
    const s = begin();
    s.session.cancel();
    expect(s.rec.abort).toHaveBeenCalledTimes(1);
    s.rec.result([[SAID, true]]);
    s.rec.error('aborted');
    s.rec.onend?.();
    expect(s.onText).not.toHaveBeenCalled();
    expect(s.onEnd).not.toHaveBeenCalled();
  });

  it('不是自己取消的 aborted 不算失败：等 end 按已认出的字结束', () => {
    const s = begin();
    s.rec.result([['买牛奶', true]]);
    s.rec.error('aborted');
    s.rec.onend?.();
    expect(s.onEnd.mock.calls).toEqual([[{ ok: true, text: '买牛奶' }]]);
  });
});

describe('运行日志：开始、结束、失败各一行，不记识别出的字', () => {
  it('开始 + 结束：语言、字数、段数、毫秒', () => {
    let t = 0;
    const r = startSpeech('zh-CN', { onEnd: vi.fn() }, () => t);
    if (!r.ok) throw new Error(r.fail);
    const rec = FakeRecognition.made[0];
    t = 150;
    rec?.onstart?.();
    rec?.result([['明天下午', true], ['三点开会', true]]);
    t = 4150;
    rec?.onend?.();
    expect(lines).toEqual(['speech start lang=zh-CN ms=150', 'speech end len=8 results=2 ms=4150']);
    expect(lines.join('\n')).not.toContain('开会');
  });

  it('失败：原因和浏览器给的错误码（只收小写字母和连字符）；取消也记一行', () => {
    const a = begin();
    a.rec.result([[SAID, false]]);
    a.rec.error('not-allowed');
    expect(lines.at(-1)).toBe('speech fail reason=denied code=not-allowed ms=0');

    const b = begin();
    b.rec.error(`Bad Code ${SAID}`);
    expect(lines.at(-1)).toBe('speech fail reason=error ms=0');

    const c = begin();
    c.session.cancel();
    expect(lines.at(-1)).toBe('speech fail reason=cancelled ms=0');
    expect(lines.join('\n')).not.toContain('开会');
  });
});
