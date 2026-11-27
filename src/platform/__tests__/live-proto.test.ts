// Gemini Live 实时转写的纯逻辑（platform/live-proto.ts）：降采样、PCM 编码、连接地址、服务器消息解析；拼字（shared/logic/join-said.ts）
import { describe, expect, it } from 'vitest';
import { joinSaid } from '../../../shared/logic/join-said.ts';
import { END_MSG, LIVE_API, LIVE_MIME, audioMsg, blockLevel, createDown16k, interimTail, liveUrl, parseServer, pcmB64, setupMsg } from '../live-proto.ts';

describe('live-proto 降采样', () => {
  it('48 kHz 降到 16 kHz：样本数是三分之一，跨块接着算不丢样本', () => {
    const down = createDown16k(48_000);
    let n = 0;
    // 128 一块（AudioWorklet 的块大小），喂 1 秒
    for (let i = 0; i < 375; i++) n += down(new Float32Array(128).fill(0.5)).length;
    expect(n).toBeGreaterThanOrEqual(15_999);
    expect(n).toBeLessThanOrEqual(16_000);
  });

  it('44.1 kHz 这种不整除的也按比例出样本', () => {
    const down = createDown16k(44_100);
    let n = 0;
    for (let i = 0; i < 100; i++) n += down(new Float32Array(441).fill(0)).length;
    // 44100 个输入 → 16000 个输出（最多差一个，留在下一块）
    expect(Math.abs(n - 16_000)).toBeLessThanOrEqual(1);
  });

  it('恒定信号降采样后还是那个值；超过 ±1 的封顶', () => {
    const half = createDown16k(48_000)(new Float32Array(960).fill(0.5));
    expect(half.length).toBe(320);
    expect([...half].every((s) => s === Math.round(0.5 * 0x7fff))).toBe(true);
    const neg = createDown16k(16_000)(new Float32Array([-2, 2, -1, 0]));
    expect([...neg]).toEqual([-0x8000, 0x7fff, -0x8000, 0]);
  });
});

describe('live-proto 编码和消息', () => {
  it('pcmB64 是小端 16 位', () => {
    const b = atob(pcmB64(new Int16Array([1, -2, 0x1234])));
    expect([...b].map((ch) => ch.charCodeAt(0))).toEqual([0x01, 0x00, 0xfe, 0xff, 0x34, 0x12]);
  });

  it('音量：静音 0，满幅封顶 1，空块 0', () => {
    expect(blockLevel(new Float32Array(128))).toBe(0);
    expect(blockLevel(new Float32Array(128).fill(1))).toBe(1);
    expect(blockLevel(new Float32Array(0))).toBe(0);
    expect(blockLevel(new Float32Array(128).fill(0.1))).toBeCloseTo(0.4, 5);
  });

  it('setup、音频、结束三种消息的形状', () => {
    expect(JSON.parse(setupMsg({ model: 'models/m' }))).toEqual({ setup: { model: 'models/m' } });
    const a = JSON.parse(audioMsg(new Int16Array([1]))) as { realtimeInput: { audio: { data: string; mimeType: string } } };
    expect(a.realtimeInput.audio.mimeType).toBe(LIVE_MIME);
    expect(LIVE_MIME).toBe('audio/pcm;rate=16000');
    expect(a.realtimeInput.audio.data).toBe(pcmB64(new Int16Array([1])));
    expect(JSON.parse(END_MSG)).toEqual({ realtimeInput: { audioStreamEnd: true } });
  });

  it('连接地址：只认 v1beta（评审第 16 条，v1alpha 也不认），令牌编码进 access_token；空令牌、太长回 null', () => {
    expect(LIVE_API).toBe('v1beta');
    const u = liveUrl('v1beta', 'auth_tokens/a b');
    expect(u).toBe('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens%2Fa%20b');
    expect(liveUrl('v1alpha', 't')).toBeNull();
    expect(liveUrl('v2', 't')).toBeNull();
    expect(liveUrl('v1beta', '')).toBeNull();
    expect(liveUrl('v1beta', 'x'.repeat(2049))).toBeNull();
  });
});

describe('live-proto 服务器消息', () => {
  it('setupComplete、正在说、定稿、一轮完、goAway', () => {
    expect(parseServer('{"setupComplete":{}}')).toEqual([{ kind: 'ready' }]);
    expect(parseServer('{"serverContent":{"interimInputTranscription":{"text":"买"}}}')).toEqual([{ kind: 'interim', text: '买' }]);
    expect(parseServer('{"serverContent":{"inputTranscription":{"text":"买牛奶"},"turnComplete":true}}')).toEqual([
      { kind: 'final', text: '买牛奶' },
      { kind: 'turn' },
    ]);
    expect(parseServer('{"serverContent":{"generationComplete":true}}')).toEqual([{ kind: 'turn' }]);
    expect(parseServer('{"goAway":{"timeLeft":"5s"}}')).toEqual([{ kind: 'away' }]);
    expect(parseServer('{"serverContent":{"modelTurn":{"parts":[]},"turnComplete":true}}')).toEqual([{ kind: 'model' }, { kind: 'turn' }]);
  });

  it('转写不带 text 当空串；不是 JSON、数组、不认识的回空', () => {
    expect(parseServer('{"serverContent":{"inputTranscription":{}}}')).toEqual([{ kind: 'final', text: '' }]);
    expect(parseServer('not json')).toEqual([]);
    expect(parseServer('[1]')).toEqual([]);
    expect(parseServer('{"usageMetadata":{}}')).toEqual([]);
  });
});

describe('live-proto 拼字', () => {
  it('joinSaid（实时转写和手机自带识别共用一份）：中文直接接，韩文隔空格，两边是英文单词隔空格，先去首尾空白', () => {
    expect(joinSaid('zh-CN', '买牛奶', '和面包')).toBe('买牛奶和面包');
    expect(joinSaid('ko-KR', '우유', '사기')).toBe('우유 사기');
    expect(joinSaid('zh-CN', '开 meeting', 'at 3')).toBe('开 meeting at 3');
    expect(joinSaid('zh-CN', '', ' 买 ')).toBe('买');
    expect(joinSaid('ko-KR', '우유 ', '')).toBe('우유');
  });

  it('正在说的这一段若从头累计，去掉已定稿的部分', () => {
    expect(interimTail('买牛奶', '买牛奶和面包')).toBe('和面包');
    expect(interimTail('买牛奶', '和面')).toBe('和面');
    expect(interimTail('', '买')).toBe('买');
  });
});
