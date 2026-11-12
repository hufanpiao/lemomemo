// R-68 录音格式探测页（B3 任务单 FA-0、Q1 第 ⑧ 条；一次性，和 voice-probe 同一个 PR 删）
// • 入口：非正式版的试验页 #/dev-csp/voice（CspLab.tsx 懒加载本页）；正式版没有试验页，build/check_no_probe.mjs 再断言产物里搜不到
// • 显示这台设备 isTypeSupported 的结果；按住按钮录一段，松开后同一段按两种标注各传一次 voice-probe，逐行显示回包
// • 录音 Blob 只在内存（传完就丢）；不写 IndexedDB；不显示账号信息
// • 结果留底（R-382，负责人录到一半被踢回登录页、结果全丢）：每段结果一回来就整份存进本机 localStorage 的单独键（voice-probe-keep.ts，
//   只存 recorder、标注、HTTP、result、gemini_http、字节、ms、转写文字，录音不存、不上传，登出清库不碰）；
//   重新进页面先显示之前的结果，“Clear results”删掉
// • 录音用正式录音器 platform/recorder.ts 的 startRecorder（Q-5“句首被吃”：原来按下就显示 Recording，其实要等拿到麦克风、
//   录音器 start 事件来了才开始收音，中间说的话全丢）。按钮三种状态：idle → starting（按下后、start 事件之前，写“Starting mic… wait”，
//   这时别说话）→ recording（start 事件之后才写“Recording… speak now”）；参数和正式录音一致：码率 shared 的 AI_AUDIO_BITS_PER_SECOND，
//   字节上限 AI_AUDIO_MAX_BYTES，时长上限 PROBE_MAX_MS（50 秒）
// • 每段多显示“mic ready +N ms”（按下到真正开录用了多久），运行日志记一行 probe mic_ready ms=N（只记数字）；留底不存这个数
// • starting 时松手：取消（startRecorder 的 signal），麦克风照样关、这一段不上传，提示“按住等 Recording 再说”，按钮回到 idle，不卡住
// • 录音中离开页面（组件卸载、pagehide）：同一个 signal 取消，马上停录音、关麦克风，这一段不上传；上传中卸载就取消上传（代码审 S1）
// • 录音器自己停了（到 50 秒上限、麦克风被系统收走）按钮改成“已到上限”或“已停”（S2），松手照样上传；
//   录音接近 600 KB 时在这一段上提示服务器会回 413（S3），超过的录音器不交出（too_large）
// • 请照 QA 事先写好、不含真实隐私的句子念（录音会进谷歌免费版，R-62）
// 开发用页面，文字不进词典（只用英文，不触发 A20），同 CspLab.tsx
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { AI_AUDIO_BITS_PER_SECOND } from '../../../shared/schema/ai.ts';
import { startRecorder, type ActiveRecorder, type RecStart } from '../../platform/recorder.ts';
import { rlog } from '../../platform/run-log-api.ts';
import {
  labelsFor,
  PROBE_MAX_BYTES,
  PROBE_MAX_MS,
  PROBE_MODELS,
  PROBE_WARN_BYTES,
  supportedTypes,
  uploadProbe,
  type ProbeModel,
  type ProbeReply,
} from '../../platform/voice-probe.ts';
import styles from './VoiceProbe.module.css';
import { keepReply, loadKept, saveKept, type KeptSegment } from './voice-probe-keep.ts';

interface Segment {
  n: number;
  mime: string;
  size: number;
  ms: number;
  /** 按下到真正开录（start 事件）用了多少毫秒；留底读回来的段没有（不存） */
  readyMs: number | null;
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
  readyMs: null,
  model: null,
  kept: true,
  replies: k.replies.map(({ label, ...r }) => ({ label, reply: { ...r, model: null, mime: null, raw_type: null, error: null } })),
});

const kb = (b: number): string => `${(b / 1024).toFixed(1)} KB`;

type Phase = 'idle' | 'starting' | 'recording';
/** 录音器自己停了：到上限 cap，别的原因（麦克风被收走、录音器出错）ended；只在 recording 时显示，按下时清掉 */
type AutoStop = 'cap' | 'ended' | null;

/** 按住的这一次：取消用 ac（松手时还在 starting、离开页面）；rec 到 start 事件以后才有 */
interface Hold {
  ac: AbortController;
  started: Promise<RecStart>;
  rec: ActiveRecorder | null;
  readyMs: number | null;
}

const LABEL: Record<Phase, string> = {
  idle: `Hold to record (max ${PROBE_MAX_MS / 1000} s)`,
  starting: 'Starting mic… wait',
  recording: 'Recording… speak now, release to upload',
};
const AUTO_LABEL: Record<'cap' | 'ended', string> = {
  cap: `Max ${PROBE_MAX_MS / 1000} s reached, release to upload`,
  ended: 'Recording stopped, release to upload',
};
/** 录音器给的失败原因 → 页面上的字（只显示原因码，too_large 补一句） */
const failText = (fail: string): string =>
  fail === 'empty' ? 'empty recording' : fail === 'too_large' ? `too_large: over ${kb(PROBE_MAX_BYTES)}, not uploaded` : `record failed: ${fail}`;

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

/** 第 n 段的第 i 种标注回来了 */
const withReply =
  (n: number, i: number, reply: ProbeReply) =>
  (all: Segment[]): Segment[] =>
    all.map((s) => (s.n === n ? { ...s, replies: s.replies.map((r, j) => (j === i ? { ...r, reply } : r)) } : s));

function SegmentRow({ s }: { s: Segment }) {
  return (
    <li className={styles.segment}>
      <div>
        #{s.n} · recorder {s.mime || '(empty)'} · {kb(s.size)} · {(s.ms / 1000).toFixed(1)} s · {s.model ?? '-'}
        {s.readyMs !== null ? ` · mic ready +${s.readyMs} ms` : ''}
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
  );
}

export default function VoiceProbe() {
  const [types] = useState(supportedTypes);
  const [model, setModel] = useState<ProbeModel>(PROBE_MODELS[0]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [auto, setAuto] = useState<AutoStop>(null);
  const [error, setError] = useState<string | null>(null);
  // 先把上次留下的结果读出来（R-382），编号接着往下排
  const [segments, setSegments] = useState<Segment[]>(() => loadKept().map(fromKept));
  const hold = useRef<Hold | null>(null);
  const count = useRef(segments.reduce((m, s) => Math.max(m, s.n), 0));

  // 每段结果一回来就整份存一次（只存已回来的标注；清空时删键）
  useEffect(() => {
    saveKept(segments.map(toKept));
  }, [segments]);
  const uploads = useRef<AbortController | null>(null);

  // 离开（组件卸载、pagehide）：starting、recording 都用 signal 取消，录音器马上停、关麦克风、不交出，不等 50 秒上限（安全审建议 ①）
  useEffect(() => {
    const ac = new AbortController();
    uploads.current = ac;
    const leave = (): void => {
      hold.current?.ac.abort();
      hold.current = null;
      setPhase('idle');
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
      // 上传中卸载：取消还没传完的（代码审 S1）
      ac.abort();
    };
  }, []);

  const begin = (e: PointerEvent<HTMLButtonElement>): void => {
    if (hold.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setError(null);
    setAuto(null);
    setPhase('starting');
    const t0 = performance.now();
    const ac = new AbortController();
    const h: Hold = {
      ac,
      rec: null,
      readyMs: null,
      started: startRecorder({
        maxMs: PROBE_MAX_MS,
        maxBytes: PROBE_MAX_BYTES,
        bitsPerSecond: AI_AUDIO_BITS_PER_SECOND,
        signal: ac.signal,
        onAutoStop: () => {
          if (hold.current === h) setAuto((h.rec?.elapsed() ?? 0) >= PROBE_MAX_MS ? 'cap' : 'ended');
        },
      }),
    };
    hold.current = h;
    void h.started.then((r) => {
      // 已经松手或离开（取消了）：这一次的结局由松手、离开那边处理；连按时不能动下一次的状态（代码审 M1）
      if (hold.current !== h) return;
      if (!r.ok) {
        hold.current = null;
        setPhase('idle');
        setError(failText(r.fail));
        return;
      }
      h.rec = r.rec;
      h.readyMs = Math.round(performance.now() - t0);
      rlog(`probe mic_ready ms=${h.readyMs}`);
      setPhase('recording');
    });
  };

  const finish = async (): Promise<void> => {
    const h = hold.current;
    if (!h) return;
    hold.current = null;
    setPhase('idle');
    if (h.rec === null) {
      // 还在 starting 就松手：取消（录音器关麦克风、不交出），这一段不传
      h.ac.abort();
      setError('released before Recording showed; hold until it says Recording, then speak');
      return;
    }
    const end = await h.rec.stop();
    if (!end.ok) {
      if (end.fail !== 'cancelled') setError(failText(end.fail));
      return;
    }
    const { clip } = end;
    const n = ++count.current;
    const labels = labelsFor(clip.mime);
    const used = model;
    setSegments((all) => [
      { n, mime: clip.mime, size: clip.blob.size, ms: clip.ms, readyMs: h.readyMs, model: used, replies: labels.map((label) => ({ label, reply: null })) },
      ...all,
    ]);
    // 一种一种传（不并发，免得耗时互相影响）；传完 clip 出了作用域就没有引用了；卸载了就不再传、不再 setState
    const signal = uploads.current?.signal;
    for (const [i, label] of labels.entries()) {
      if (signal?.aborted) return;
      const reply = await uploadProbe(clip.blob, label, used, undefined, signal);
      if (signal?.aborted) return;
      setSegments(withReply(n, i, reply));
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
        data-phase={phase}
        data-recording={phase === 'recording' ? '1' : '0'}
        data-capped={phase === 'recording' && auto === 'cap' ? '1' : '0'}
        onPointerDown={begin}
        onPointerUp={() => void finish()}
        onPointerCancel={() => void finish()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {phase === 'recording' && auto !== null ? AUTO_LABEL[auto] : LABEL[phase]}
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
          <SegmentRow key={s.n} s={s} />
        ))}
      </ol>
    </main>
  );
}
