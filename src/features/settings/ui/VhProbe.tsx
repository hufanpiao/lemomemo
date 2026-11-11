// 可见高度真机探测按钮（R-371 第二条路，platform/vh-probe.ts）：只在设置 › 关于的诊断打开时、非正式版里出现（AboutSection 挂）。
// 一次只跑一种（跑着时按钮都禁用）；结果一行一条累加在下面，负责人截图。按钮字是英文、不进词典（同诊断区，A20 只管汉字）
// Gap fix（R-371，platform/vh-gapfix.ts，11-11 起 iOS 主屏幕版默认开）：开关改成“关掉用来对照”——默认 ON，点成 OFF 存本机，下次冷启动起不做（再点回 ON 恢复默认）；下面显示最近一次冷启动的日志，“Copy gap fix log”整段复制（和时间线开关可以同时开）
// 冷启动时间线（R-371，11-10，platform/vh-timeline.ts）：再多一排——“Timeline next launch: OFF/ON”开关（存本机，下次冷启动记 3 分钟，开始记就自动关）、
// “Copy timeline”整段复制上一次记下的时间线；下面显示那段时间线（按“Copy timeline”时重新读本机，记着的时候也能拿到最新的）
// 启动画面颜色诊断（台账 Q-2，platform/splash-probe-arm.ts）：再一排“Splash colors next launch: OFF/ON”开关（存本机，下次冷启动涂色 20 秒，开始涂就自动关）
// 键盘上方输入辅助条诊断（台账 Q-11，KbAccessoryProbe.tsx）：再一排“Keyboard bar test”，点了才下载测试层（React.lazy），A～H 八种输入写法逐个点
import { lazy, Suspense, useState } from 'react';
import { FormButton } from '../../../kit/components/Form.tsx';
import { runVhMethod, VH_METHODS } from '../../../platform/vh-probe.ts';
import { gapFixOn, readGapFixLog, setGapFixOn } from '../../../platform/vh-gapfix.ts';
import { readTimeline, setTimelineArmed, timelineArmed } from '../../../platform/vh-timeline.ts';
import { setSplashProbeArmed, splashProbeArmed } from '../../../platform/splash-probe-arm.ts';
import styles from './SettingsPage.module.css';

// 顶层的 lazy() 打包器当有副作用不删，正式构建要靠 MODE 常量挡住，连同动态分包一起摇掉（check_no_probe 兜底）
const KbAccessoryProbe = import.meta.env.MODE === 'production' ? null : lazy(() => import('./KbAccessoryProbe.tsx'));
export const KB_TEST_LABEL = 'Keyboard bar test';

export const TL_LABEL_ON = 'Timeline next launch: ON';
export const TL_LABEL_OFF = 'Timeline next launch: OFF';
export const TL_COPY = 'Copy timeline';
export const TL_COPIED = 'Copied';
export const GF_LABEL_ON = 'Gap fix: ON';
export const GF_LABEL_OFF = 'Gap fix: OFF (compare)';
export const GF_COPY = 'Copy gap fix log';
export const SP_LABEL_ON = 'Splash colors next launch: ON';
export const SP_LABEL_OFF = 'Splash colors next launch: OFF';
export const TL_COPY_FAIL = 'Copy failed - long-press the text below';

export function VhProbe() {
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [armed, setArmed] = useState(() => timelineArmed());
  const [tl, setTl] = useState(() => readTimeline());
  const [gf, setGf] = useState(() => gapFixOn());
  const [sp, setSp] = useState(() => splashProbeArmed());
  const [gfLog, setGfLog] = useState(() => readGapFixLog());
  const [kbTest, setKbTest] = useState(false);
  const [copied, setCopied] = useState<'' | 'ok' | 'fail'>('');
  const [gfCopied, setGfCopied] = useState<'' | 'ok' | 'fail'>('');
  /** 整段复制（按的时候重新读本机，记着的时候也拿最新的）；时间线、Gap fix 两个开关可以同时开，日志各复制各的 */
  const copyText = (text: string, done: (s: 'ok' | 'fail') => void): void => {
    try {
      void navigator.clipboard.writeText(text).then(
        () => done('ok'),
        () => done('fail'),
      );
    } catch {
      done('fail');
    }
  };
  const copy = (): void => {
    const text = readTimeline();
    setTl(text);
    copyText(text, setCopied);
  };
  const copyGf = (): void => {
    const text = readGapFixLog();
    setGfLog(text);
    copyText(text, setGfCopied);
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
      <div className={`${styles.actions} ${styles.probeActions}`}>
        <FormButton
          size="compact"
          aria-pressed={gf}
          data-testid="vh-gapfix"
          onClick={() => {
            setGapFixOn(!gf);
            setGf(gapFixOn());
          }}
        >
          {gf ? GF_LABEL_ON : GF_LABEL_OFF}
        </FormButton>
        <FormButton size="compact" disabled={gfLog === ''} data-testid="vh-gapfix-copy" onClick={copyGf}>
          {gfCopied === 'ok' ? TL_COPIED : gfCopied === 'fail' ? TL_COPY_FAIL : GF_COPY}
        </FormButton>
      </div>
      <div className={`${styles.actions} ${styles.probeActions}`}>
        <FormButton
          size="compact"
          aria-pressed={sp}
          data-testid="vh-sp-arm"
          onClick={() => {
            setSplashProbeArmed(!sp);
            setSp(splashProbeArmed());
          }}
        >
          {sp ? SP_LABEL_ON : SP_LABEL_OFF}
        </FormButton>
      </div>
      <div className={`${styles.actions} ${styles.probeActions}`}>
        <FormButton size="compact" data-testid="kbacc-probe-open" onClick={() => setKbTest(true)}>
          {KB_TEST_LABEL}
        </FormButton>
      </div>
      {kbTest && KbAccessoryProbe && (
        <Suspense fallback={null}>
          <KbAccessoryProbe onClose={() => setKbTest(false)} />
        </Suspense>
      )}
      {gfLog !== '' && (
        <pre className={styles.diag} data-testid="vh-gapfix-out">
          {gfLog}
        </pre>
      )}
    </div>
  );
}
