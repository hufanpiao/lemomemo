// R-68 探测页的结果留底（R-382：负责人录到一半被踢回登录页，页面上的转写结果全丢了）
// • 每段结果出来就存一份到本机 localStorage 的单独键 KEEP_KEY；重新进探测页时显示出来，“Clear results”才删
// • 只存这几样：recorder（录音格式）、标注、HTTP、result、gemini_http、字节、ms（录音时长、gemini、服务器、往返）、转写文字；
//   录音本身不存（Blob 仍然只在内存里），不存账号信息，不上传
// • 登出清库碰不到这个键：platform/sign-out.ts 只删 IndexedDB、Cache Storage、sb-*-auth-token 会话键和 lemo.logq.* 日志队列，
//   代码里也没有整库清空 localStorage 的写法（单测 voice-probe-keep.test.tsx 断言这些规则都不匹配 KEEP_KEY）
// • 只在预览版：本文件只被 VoiceProbe.tsx 引用，正式构建整块摇掉；键名带 voice-probe，build/check_no_probe.mjs 会在正式产物里搜它；
//   万一被正式版引到，MODE 为 production 时读写都不做
// • 最多留 KEEP_MAX 段（新的在前），存不下（配额满、无痕模式）就算了，不影响录音和上传
// 纯 TS：不准 import React（A1）；不 import platform/voice-probe.ts（tests/build/check-no-probe.test.ts：那个文件只准探测页引用），回包的形状在这里自己写

export const KEEP_KEY = 'lemo-voice-probe-results';
export const KEEP_MAX = 100;

export interface KeptReply {
  label: string;
  status: number;
  result: string | null;
  gemini_http: number | null;
  bytes: number | null;
  gemini_ms: number | null;
  total_ms: number | null;
  client_ms: number;
  transcript: string | null;
}

export interface KeptSegment {
  n: number;
  /** MediaRecorder 实际用的格式 */
  recorder: string;
  /** 录音字节数 */
  size: number;
  ms: number;
  /** 还没回来的标注不存 */
  replies: KeptReply[];
}

const on = (): boolean => import.meta.env.MODE !== 'production';
const store = (s?: Storage): Storage | null => {
  try {
    return s ?? globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** 回包里要存的那几项（platform/voice-probe.ts 的 ProbeReply 的子集，结构上兼容） */
export type ReplyLike = Omit<KeptReply, 'label'>;

/** 只挑白名单里的字段（存进去、读出来都过一遍，多出来的字段一律不要） */
export function keepReply(label: string, r: ReplyLike): KeptReply {
  return {
    label,
    status: num(r.status) ?? 0,
    result: str(r.result),
    gemini_http: num(r.gemini_http),
    bytes: num(r.bytes),
    gemini_ms: num(r.gemini_ms),
    total_ms: num(r.total_ms),
    client_ms: num(r.client_ms) ?? 0,
    transcript: str(r.transcript),
  };
}

function segmentOf(v: unknown): KeptSegment | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const n = num(o['n']);
  if (n === null || !Array.isArray(o['replies'])) return null;
  const replies = (o['replies'] as unknown[]).flatMap((r) => {
    if (typeof r !== 'object' || r === null) return [];
    const x = r as Record<string, unknown>;
    const label = str(x['label']);
    return label === null ? [] : [keepReply(label, x as unknown as ReplyLike)];
  });
  return { n, recorder: str(o['recorder']) ?? '', size: num(o['size']) ?? 0, ms: num(o['ms']) ?? 0, replies };
}

/** 读出之前留下的结果（新的在前）；没有、坏了、读不了都回空数组 */
export function loadKept(storage?: Storage): KeptSegment[] {
  if (!on()) return [];
  try {
    const raw = store(storage)?.getItem(KEEP_KEY);
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.flatMap((s) => segmentOf(s) ?? []).slice(0, KEEP_MAX) : [];
  } catch {
    return [];
  }
}

/** 整份写回；空数组就删键（“Clear results”）。不抛 */
export function saveKept(segments: readonly KeptSegment[], storage?: Storage): void {
  if (!on()) return;
  try {
    const s = store(storage);
    if (!s) return;
    const keep = segments.filter((x) => x.replies.length > 0).slice(0, KEEP_MAX).flatMap((x) => segmentOf(x) ?? []);
    if (keep.length === 0) s.removeItem(KEEP_KEY);
    else s.setItem(KEEP_KEY, JSON.stringify(keep));
  } catch {
    // 存不下：只是没留底，不影响探测
  }
}
