// R-68 录音格式探测（B3 任务单 FA-0、Q1 第 ⑧ 条；一次性，和 supabase/functions/_preview/voice-probe 同一个 PR 下线）
// • 只给探测页 src/app/dev/VoiceProbe.tsx 用；探测页只在非正式版的试验页 #/dev-csp/voice 下懒加载，
//   正式产物里整块不存在（build/check_no_probe.mjs 在正式构建后断言搜不到 voice-probe 和探测页标记）
// • 录音 Blob 只在内存：不写 IndexedDB、Cache、localStorage，传完由页面丢掉引用；不读、不显示账号信息（只取会话的 JWT 放进请求头）
// • 同一段录音按两种 Content-Type 标注各传一次（iPhone 的 AAC：audio/mp4、audio/aac；电脑 Edge 的 WebM：audio/webm、audio/webm;codecs=opus）
// • 回包只取约定的几个字段（mime、raw_type、bytes、gemini_http、gemini_ms、total_ms、result、transcript、model、error），别的不显示
// 网络和 MediaRecorder 按 A12、A13 只能写在 platform
import { buildInfo } from './env.ts';
import { appFetch } from './http.ts';
import { readSessionAccessToken } from './session.ts';
import { getSupabase } from './supabase/client.ts';

/** 同 _preview/voice-probe/handler.ts 的 MODELS（由请求头 X-Model 指定，没有默认值） */
export const PROBE_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'] as const;
export type ProbeModel = (typeof PROBE_MODELS)[number];
/** 显示 isTypeSupported 的几种 */
export const PROBE_TYPES = ['audio/mp4', 'audio/aac', 'audio/webm', 'audio/webm;codecs=opus', 'audio/mpeg', 'audio/ogg;codecs=opus'] as const;
/** 一段最长录多久（同正式录音的 50 秒） */
export const PROBE_MAX_MS = 50_000;
export const PROBE_UPLOAD_TIMEOUT_MS = 30_000;
/** 服务器收的上限（_preview/voice-probe/handler.ts ⑧：超了回 413）；iPhone 的 AAC 录满 50 秒可能超 */
export const PROBE_MAX_BYTES = 600 * 1024;
/** 到上限的九成就在页面上提示 */
export const PROBE_WARN_BYTES = Math.round(PROBE_MAX_BYTES * 0.9);
const MAX_TRANSCRIPT = 2000;

export const probeUrl = (base: string = buildInfo.supabaseUrl): string => `${base}/functions/v1/voice-probe`;

/** 这台设备支持哪几种（没有 MediaRecorder 时全是 false） */
export function supportedTypes(): { type: string; ok: boolean }[] {
  const MR = typeof MediaRecorder === 'undefined' ? null : MediaRecorder;
  return PROBE_TYPES.map((type) => {
    let ok = false;
    try {
      ok = MR !== null && MR.isTypeSupported(type);
    } catch {
      ok = false;
    }
    return { type, ok };
  });
}

/** 实际录出的 mimeType → 要试的两种标注 */
export function labelsFor(actual: string): string[] {
  const base = actual.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === 'audio/mp4' || base === 'audio/aac' || base === 'audio/x-m4a') return ['audio/mp4', 'audio/aac'];
  if (base === 'audio/webm') return ['audio/webm', 'audio/webm;codecs=opus'];
  return [actual || 'application/octet-stream'];
}

export interface ProbeClip {
  blob: Blob;
  /** recorder.mimeType（浏览器实际给的） */
  mime: string;
  ms: number;
}

export interface Recording {
  stop(): Promise<ProbeClip>;
  cancel(): void;
}

/** 开始录音（要在点按里调）；onCap：到 50 秒上限、录音器自己停了时调（页面提示“已到上限”） */
export async function startRecording(now: () => number = () => performance.now(), onCap?: () => void): Promise<Recording> {
  // 不记麦克风结果（不引 perm.ts：引了它会从提醒块里拆成独立块，主块的依赖表多一项，首屏稳定口径 +6 B）
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const end = (): void => {
    for (const t of stream.getTracks()) t.stop();
  };
  const parts: Blob[] = [];
  let cap: ReturnType<typeof setTimeout> | undefined;
  let rec: MediaRecorder;
  let done: Promise<ProbeClip>;
  // 拿到麦克风以后，建录音器或 start 抛错（不支持、设备被占用）：先关轨道、清计时器再抛，免得系统的录音指示一直亮着（代码审 M2）
  try {
    const r = new MediaRecorder(stream);
    rec = r;
    const t0 = now();
    r.addEventListener('dataavailable', (ev) => {
      if (ev.data.size > 0) parts.push(ev.data);
    });
    done = new Promise<ProbeClip>((resolve) => {
      r.addEventListener('stop', () => {
        clearTimeout(cap);
        end();
        const mime = r.mimeType || parts[0]?.type || '';
        resolve({ blob: new Blob(parts, { type: mime }), mime, ms: Math.round(now() - t0) });
        parts.length = 0;
      });
    });
    cap = setTimeout(() => {
      if (r.state === 'recording') {
        r.stop();
        onCap?.();
      }
    }, PROBE_MAX_MS);
    r.start();
  } catch (err) {
    clearTimeout(cap);
    end();
    throw err;
  }
  return {
    stop() {
      if (rec.state === 'recording') rec.stop();
      return done;
    },
    cancel() {
      clearTimeout(cap);
      if (rec.state === 'recording') rec.stop();
      end();
    },
  };
}

export interface ProbeReply {
  /** HTTP 状态；0 = 没发出去（断网、超时、没登录） */
  status: number;
  model: string | null;
  mime: string | null;
  raw_type: string | null;
  bytes: number | null;
  gemini_http: number | null;
  gemini_ms: number | null;
  total_ms: number | null;
  result: string | null;
  transcript: string | null;
  error: string | null;
  /** 页面这边量的往返耗时 */
  client_ms: number;
}

const str = (v: unknown, max = 120): string | null => (typeof v === 'string' ? [...v].slice(0, max).join('') : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 回包 → 只取约定的字段 */
export function replyOf(status: number, body: unknown, clientMs: number): ProbeReply {
  const r = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return {
    status,
    model: str(r['model']),
    mime: str(r['mime']),
    raw_type: str(r['raw_type']),
    bytes: num(r['bytes']),
    gemini_http: num(r['gemini_http']),
    gemini_ms: num(r['gemini_ms']),
    total_ms: num(r['total_ms']),
    result: str(r['result']),
    transcript: str(r['transcript'], MAX_TRANSCRIPT),
    error: str(r['error']),
    client_ms: clientMs,
  };
}

export interface UploadDeps {
  token(): Promise<string | null>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  now(): number;
}

const defaultUpload: UploadDeps = {
  async token() {
    // 先问 supabase-js（过期会自己换新）；问不到时退回本机存的会话令牌（失效的话服务器回 404，页面照样显示出来）
    try {
      const db = await getSupabase();
      const { data, error } = await db.auth.getSession();
      if (!error && data.session?.access_token) return data.session.access_token;
    } catch {
      // 落到下面
    }
    return readSessionAccessToken();
  },
  fetch: (url, init) => appFetch(url, init),
  now: () => performance.now(),
};

/** 把同一段录音按 label 这个 Content-Type 传一次；signal：页面卸载时取消（代码审 S1，免得离开后还在花当天的探测次数） */
export async function uploadProbe(clip: Blob, label: string, model: ProbeModel, d: UploadDeps = defaultUpload, signal?: AbortSignal): Promise<ProbeReply> {
  const t0 = d.now();
  const fail = (error: string): ProbeReply => replyOf(0, { error }, Math.round(d.now() - t0));
  if (signal?.aborted) return fail('cancelled');
  const jwt = await d.token().catch(() => null);
  if (jwt === null) return fail('signed_out');
  if (signal?.aborted) return fail('cancelled');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_UPLOAD_TIMEOUT_MS);
  const onCancel = (): void => ac.abort();
  signal?.addEventListener('abort', onCancel);
  try {
    const res = await d.fetch(probeUrl(), {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, apikey: buildInfo.anonKey, 'content-type': label, 'x-model': model },
      body: clip,
      signal: ac.signal,
      cache: 'no-store',
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return replyOf(res.status, body, Math.round(d.now() - t0));
  } catch {
    return fail(signal?.aborted ? 'cancelled' : ac.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCancel);
  }
}
