// R-68 录音格式探测页（B3 任务单 FA-0、Q1 第 ⑧ 条；一次性，和 voice-probe 同一个 PR 删）
// • 入口：非正式版的试验页 #/dev-csp/voice（CspLab.tsx 懒加载本页）；正式版没有试验页，build/check_no_probe.mjs 再断言产物里搜不到
// • 显示这台设备 isTypeSupported 的结果；按住按钮录一段，松开后同一段按两种标注各传一次 voice-probe，逐行显示回包
// • 录音 Blob 只在内存（传完就丢）；不写 IndexedDB；不显示账号信息
// • 结果留底（R-382，负责人录到一半被踢回登录页、结果全丢）：每段结果一回来就整份存进本机 localStorage 的单独键（voice-probe-keep.ts，
//   只存 recorder、标注、HTTP、result、gemini_http、字节、ms、转写文字，录音不存、不上传，登出清库不碰）；
//   重新进页面先显示之前的结果，“Clear results”删掉
// • 录音中离开页面（组件卸载、pagehide）马上停录音、关麦克风，这一段不上传；上传中卸载就取消上传（代码审 S1）
// • 到 50 秒上限按钮改成“已到上限”（S2）；录音接近 600 KB 时在这一段上提示服务器会回 413（S3）
// • 请照 QA 事先写好、不含真实隐私的句子念（录音会进谷歌免费版，R-62）
// 开发用页面，文字不进词典（只用英文，不触发 A20），同 CspLab.tsx
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import {
  labelsFor,
  PROBE_MAX_BYTES,
  PROBE_MAX_MS,
  PROBE_MODELS,
  PROBE_WARN_BYTES,
  startRecording,
  supportedTypes,
  uploadProbe,
  type ProbeModel,
  type ProbeReply,
  type Recording,
} from '../../platform/voice-probe.ts';
import styles from './VoiceProbe.module.css';
import { keepReply, loadKept, saveKept, type KeptSegment } from './voice-probe-keep.ts';

interface Segment {
  n: number;
  mime: string;
  size: number;
  ms: number;
  /** 从本机留底读回来的段没有模型（不存） */
  model: ProbeModel | null;
  replies: { label: string; reply: ProbeReply | null }[];
  /** 上次留下的结果 */
  kept?: boolean;
}

/** 存：只存已经回来的标注，字段按白名单挑 */
const toKept = (s: Segment): KeptSegment => ({
  n: s.n,
  recorder: s.mime,
  size: s.size,
  ms: s.ms,
  replies: s.replies.flatMap((r) => (r.reply ? [keepReply(r.label, r.reply)] : [])),
});
/** 读：没存的字段显示成 - */
const fromKept = (k: KeptSegment): Segment => ({
  n: k.n,
  mime: k.recorder,
  size: k.size,
  ms: k.ms,
  model: null,
  kept: true,
  replies: k.replies.map(({ label, ...r }) => ({ label, reply: { ...r, model: null, mime: null, raw_type: null, error: null } })),
});

const kb = (b: number): string => `${(b / 1024).toFixed(1)} KB`;

/** 录音出错的显示：直接看 name、message（不用 instanceof：DOMException 在有的环境里不算 Error 的实例） */
function errText(err: unknown): string {
  const e = typeof err === 'object' && err !== null ? (err as { name?: unknown; message?: unknown }) : {};
  return typeof e.name === 'string' && typeof e.message === 'string' ? `${e.name}: ${e.message}` : 'record_failed';
}

function ReplyRow({ label, reply }: { label: string; reply: ProbeReply | null }) {
  if (reply === null) return <li className={styles.reply}>{label}: uploading…</li>;
  const ok = reply.status === 200 && reply.result === 'ok' && (reply.transcript ?? '') !== '';
  return (
    <li className={styles.reply} data-ok={ok ? '1' : '0'}>
      <div>
        <b>{label}</b> · HTTP {reply.status} · {reply.result ?? reply.error ?? '-'}
      </div>
      <div>
        mime {reply.mime ?? '-'} · raw {reply.raw_type ?? '-'} · {reply.bytes ?? '-'} B · gemini_http {reply.gemini_http ?? '-'}
      </div>
      <div>
        gemini {reply.gemini_ms ?? '-'} ms · server {reply.total_ms ?? '-'} ms · round trip {reply.client_ms} ms
      </div>
      <div className={styles.transcript}>{reply.transcript ?? ''}</div>
    </li>
  );
}

export default function VoiceProbe() {
  const [types] = useState(supportedTypes);
  const [model, setModel] = useState<ProbeModel>(PROBE_MODELS[0]);
  const [recording, setRecording] = useState(false);
  const [capped, setCapped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 先把上次留下的结果读出来（R-382），编号接着往下排
  const [segments, setSegments] = useState<Segment[]>(() => loadKept().map(fromKept));
  const rec = useRef<Promise<Recording> | null>(null);
  const count = useRef(segments.reduce((m, s) => Math.max(m, s.n), 0));

  // 每段结果一回来就整份存一次（只存已回来的标注；清空时删键）
  useEffect(() => {
    saveKept(segments.map(toKept));
  }, [segments]);
  const uploads = useRef<AbortController | null>(null);

  // 录音中离开（组件卸载、pagehide）：马上停掉 MediaRecorder 和麦克风轨道、不上传，不等 50 秒上限（安全审建议 ①）
  useEffect(() => {
    const ac = new AbortController();
    uploads.current = ac;
    const leave = (): void => {
      const p = rec.current;
      rec.current = null;
      if (p) p.then((r) => r.cancel(), () => undefined);
      setRecording(false);
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
      // 上传中卸载：取消还没传完的（代码审 S1）
      ac.abort();
    };
  }, []);

  const patch = (n: number, i: number, reply: ProbeReply): void =>
    setSegments((all) => all.map((s) => (s.n === n ? { ...s, replies: s.replies.map((r, j) => (j === i ? { ...r, reply } : r)) } : s)));

  const begin = (e: PointerEvent<HTMLButtonElement>): void => {
    if (rec.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setError(null);
    setRecording(true);
    setCapped(false);
    const p: Promise<Recording> = startRecording(undefined, () => {
      if (rec.current === p) setCapped(true);
    });
    rec.current = p;
    p.catch((err: unknown) => {
      // 连按：这一次还在等权限时松手、又按了一次，这一次后来失败，不能清掉下一次的句柄和状态（代码审 M1）
      if (rec.current !== p) return;
      rec.current = null;
      setRecording(false);
      setError(errText(err));
    });
  };

  const finish = async (): Promise<void> => {
    const p = rec.current;
    if (!p) return;
    rec.current = null;
    setRecording(false);
    setCapped(false);
    let clip;
    try {
      clip = await (await p).stop();
    } catch {
      return;
    }
    if (clip.blob.size === 0) {
      setError('empty recording');
      return;
    }
    const n = ++count.current;
    const labels = labelsFor(clip.mime);
    const used = model;
    setSegments((all) => [
      { n, mime: clip.mime, size: clip.blob.size, ms: clip.ms, model: used, replies: labels.map((label) => ({ label, reply: null })) },
      ...all,
    ]);
    // 一种一种传（不并发，免得耗时互相影响）；传完 clip 出了作用域就没有引用了；卸载了就不再传、不再 setState
    const signal = uploads.current?.signal;
    for (const [i, label] of labels.entries()) {
      if (signal?.aborted) return;
      const reply = await uploadProbe(clip.blob, label, used, undefined, signal);
      if (signal?.aborted) return;
      patch(n, i, reply);
    }
  };

  return (
    <main className={styles.page} data-testid="voice-probe">
      <h1>Voice probe (R-68)</h1>
      <p className={styles.note}>Read only the prepared test sentences. Do not say real names, phone numbers, addresses or private matters.</p>
      <section>
        <h2>isTypeSupported</h2>
        <ul className={styles.list} data-testid="probe-types">
          {types.map((t) => (
            <li key={t.type}>
              {t.type}: {t.ok ? 'yes' : 'no'}
            </li>
          ))}
        </ul>
      </section>
      <section className={styles.models} aria-label="Model">
        {PROBE_MODELS.map((m) => (
          <button key={m} type="button" className={styles.chip} aria-pressed={model === m} onClick={() => setModel(m)}>
            {m}
          </button>
        ))}
      </section>
      <button
        type="button"
        className={styles.hold}
        data-testid="probe-hold"
        data-recording={recording ? '1' : '0'}
        data-capped={capped ? '1' : '0'}
        onPointerDown={begin}
        onPointerUp={() => void finish()}
        onPointerCancel={() => void finish()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {recording
          ? capped
            ? `Max ${PROBE_MAX_MS / 1000} s reached, release to upload`
            : 'Recording… release to upload'
          : `Hold to record (max ${PROBE_MAX_MS / 1000} s)`}
      </button>
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {segments.length > 0 && (
        <button type="button" className={styles.chip} data-testid="probe-clear" onClick={() => setSegments([])}>
          Clear results
        </button>
      )}
      <ol className={styles.list} data-testid="probe-results">
        {segments.map((s) => (
          <li key={s.n} className={styles.segment}>
            <div>
              #{s.n} · recorder {s.mime || '(empty)'} · {kb(s.size)} · {(s.ms / 1000).toFixed(1)} s · {s.model ?? '-'}
              {s.kept ? ' · saved earlier' : ''}
            </div>
            {s.size >= PROBE_WARN_BYTES && (
              <div className={styles.error} data-testid="probe-size-warn">
                {s.size > PROBE_MAX_BYTES ? 'Over' : 'Close to'} the {kb(PROBE_MAX_BYTES)} server limit; above it the server replies 413
              </div>
            )}
            <ul className={styles.list}>
              {s.replies.map((r) => (
                <ReplyRow key={r.label} label={r.label} reply={r.reply} />
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </main>
  );
}
