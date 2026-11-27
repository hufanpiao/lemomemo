// Gemini Live 实时转写的纯逻辑（platform/live-transcribe.ts 用）。协议按官方文档：
// • 只认 v1beta：短期令牌只在 v1beta 上能用（和服务器 ai-live-token/core.ts 的 LIVE_API 由 tests/edge/ai-live-client.test.ts 钉成一样）
// • 连上先发 {setup}（服务器锁进令牌的那一份），等 setupComplete；音频 16 kHz 16 位单声道小端 PCM，约 100 ms 一块
// • interimInputTranscription 随时会改；inputTranscription 是定稿的一段、往后接；modelTurn 本不该有，只计条数进日志。
//   inputTranscription 和 turnComplete 谁先到不保证（live-transcribe.ts 收尾的宽限就是为这个）
// 不碰 DOM、网络、音频设备，不记日志。
import { isObj } from '../../shared/core/field.ts';

export const LIVE_RATE = 16_000;
export const LIVE_MIME = `audio/pcm;rate=${LIVE_RATE}`;
const LIVE_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage';
export const LIVE_API = 'v1beta';

/** 带短期令牌的连接地址；版本号不认识、令牌不像样回 null */
export function liveUrl(api: string, token: string): string | null {
  if (api !== LIVE_API || token === '' || token.length > 2048) return null;
  return `${LIVE_WS}.${api}.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`;
}

/**
 * 降到 16 kHz：每个输出样本取对应那一段的加权平均（盒式低通防混叠），跨块接着算、不丢样本。每次喂一块，交出能算出来的 16 位样本
 */
export function createDown16k(inRate: number): (block: Float32Array) => Int16Array {
  const step = inRate / LIVE_RATE;
  let carry = new Float32Array(0);
  /** 下一个输出样本在 carry 里的起点（可以是小数） */
  let pos = 0;
  return (block) => {
    const data = new Float32Array(carry.length + block.length);
    data.set(carry);
    data.set(block, carry.length);
    const out: number[] = [];
    while (pos + step <= data.length) {
      const a = pos;
      const b = pos + step;
      let sum = 0;
      let w = 0;
      for (let i = Math.floor(a); i < Math.ceil(b); i++) {
        const k = Math.min(b, i + 1) - Math.max(a, i);
        sum += (data[i] ?? 0) * k;
        w += k;
      }
      out.push(w > 0 ? sum / w : 0);
      pos += step;
    }
    const keep = Math.floor(pos);
    carry = data.slice(keep);
    pos -= keep;
    const pcm = new Int16Array(out.length);
    out.forEach((s, i) => {
      const x = Math.max(-1, Math.min(1, s));
      pcm[i] = x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff);
    });
    return pcm;
  };
}

/** 16 位样本 → 小端字节 → base64 */
export function pcmB64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  const dv = new DataView(bytes.buffer);
  pcm.forEach((s, i) => dv.setInt16(i * 2, s, true));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** 这一块的音量 0～1（和录音器的音量计同一个算法：均方根 × 4，封顶 1） */
export function blockLevel(block: Float32Array): number {
  if (block.length === 0) return 0;
  let sum = 0;
  for (const v of block) sum += v * v;
  return Math.min(1, Math.sqrt(sum / block.length) * 4);
}

export const setupMsg = (setup: Record<string, unknown>): string => JSON.stringify({ setup });
export const audioMsg = (pcm: Int16Array): string => JSON.stringify({ realtimeInput: { audio: { data: pcmB64(pcm), mimeType: LIVE_MIME } } });
export const END_MSG = JSON.stringify({ realtimeInput: { audioStreamEnd: true } });

export type LiveMsg =
  | { kind: 'ready' }
  | { kind: 'interim'; text: string }
  | { kind: 'final'; text: string }
  | { kind: 'turn' }
  | { kind: 'model' }
  | { kind: 'away' };

/** 转写里的 text；没有（SMART 模式改光了时不带）当空串 */
const textOf = (v: unknown): string | null => (isObj(v) ? (typeof v.text === 'string' ? v.text : '') : null);

/** 服务器的一条消息 → 关心的几件事（一条里可能同时有定稿的字和 turnComplete，按先字后完的顺序）；不是 JSON、不认识的回空 */
export function parseServer(raw: string): LiveMsg[] {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isObj(v)) return [];
  const out: LiveMsg[] = [];
  if ('setupComplete' in v) out.push({ kind: 'ready' });
  const sc = v.serverContent;
  if (isObj(sc)) {
    const interim = textOf(sc.interimInputTranscription);
    if (interim !== null) out.push({ kind: 'interim', text: interim });
    const fin = textOf(sc.inputTranscription);
    if (fin !== null) out.push({ kind: 'final', text: fin });
    if (isObj(sc.modelTurn)) out.push({ kind: 'model' });
    if (sc.turnComplete === true || sc.generationComplete === true) out.push({ kind: 'turn' });
  }
  if ('goAway' in v) out.push({ kind: 'away' });
  return out;
}

/** 正在说的这一段：万一服务器给的是从头累计的（以定稿的字开头），去掉已经定稿的那部分，免得显示两遍 */
export function interimTail(finals: string, interim: string): string {
  const f = finals.trim();
  const i = interim.trim();
  return f !== '' && i.startsWith(f) ? i.slice(f.length) : i;
}
