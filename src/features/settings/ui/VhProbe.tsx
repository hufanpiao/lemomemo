// 可见高度真机探测按钮（R-371 第二条路，platform/vh-probe.ts）：只在设置 › 关于的诊断打开时、非正式版里出现（AboutSection 挂）。
// 一次只跑一种（跑着时按钮都禁用）；结果一行一条累加在下面，负责人截图。按钮字是英文、不进词典（同诊断区，A20 只管汉字）
// 冷启动时间线（R-371，11-10，platform/vh-timeline.ts）：再多一排——“Timeline next launch: OFF/ON”开关（存本机，下次冷启动记 3 分钟，开始记就自动关）、
// “Copy timeline”整段复制上一次记下的时间线；下面显示那段时间线（按“Copy timeline”时重新读本机，记着的时候也能拿到最新的）
import { useState } from 'react';
import { FormButton } from '../../../kit/components/Form.tsx';
import { runVhMethod, VH_METHODS } from '../../../platform/vh-probe.ts';
import { readTimeline, setTimelineArmed, timelineArmed } from '../../../platform/vh-timeline.ts';
import styles from './SettingsPage.module.css';

export const TL_LABEL_ON = 'Timeline next launch: ON';
export const TL_LABEL_OFF = 'Timeline next launch: OFF';
export const TL_COPY = 'Copy timeline';
export const TL_COPIED = 'Copied';
export const TL_COPY_FAIL = 'Copy failed - long-press the text below';

export function VhProbe() {
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [armed, setArmed] = useState(() => timelineArmed());
  const [tl, setTl] = useState(() => readTimeline());
  const [copied, setCopied] = useState<'' | 'ok' | 'fail'>('');
  const copy = (): void => {
    const text = readTimeline();
    setTl(text);
    const done = (ok: boolean): void => setCopied(ok ? 'ok' : 'fail');
    try {
      void navigator.clipboard.writeText(text).then(
        () => done(true),
        () => done(false),
      );
    } catch {
      done(false);
    }
  };
  return (
    <div data-testid="settings-vh-probe">
      <div className={`${styles.actions} ${styles.probeActions}`}>
        {VH_METHODS.map((m) => (
          <FormButton
            key={m.id}
            size="compact"
            disabled={busy}
            data-testid={`vh-probe-${m.id}`}
            onClick={() => {
              setBusy(true);
              void runVhMethod(m)
                .then((line) => setLines((l) => [...l, line]))
                .finally(() => setBusy(false));
            }}
          >
            {m.label}
          </FormButton>
        ))}
      </div>
      {lines.length > 0 && (
        <pre className={styles.diag} data-testid="settings-vh-probe-out">
          {lines.join('\n')}
        </pre>
      )}
      <div className={`${styles.actions} ${styles.probeActions}`}>
        <FormButton
          size="compact"
          aria-pressed={armed}
          data-testid="vh-tl-arm"
          onClick={() => {
            setTimelineArmed(!armed);
            setArmed(timelineArmed());
          }}
        >
          {armed ? TL_LABEL_ON : TL_LABEL_OFF}
        </FormButton>
        <FormButton size="compact" disabled={tl === ''} data-testid="vh-tl-copy" onClick={copy}>
          {copied === 'ok' ? TL_COPIED : copied === 'fail' ? TL_COPY_FAIL : TL_COPY}
        </FormButton>
      </div>
      {tl !== '' && (
        <pre className={styles.diag} data-testid="vh-tl-out">
          {tl}
        </pre>
      )}
    </div>
  );
}
