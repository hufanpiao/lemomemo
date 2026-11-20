// 非正式版诊断区的按钮（AboutSection 在设置 › 关于的诊断打开时挂；正式构建靠 MODE 常量摇掉，build/check_no_probe.mjs 的 PROBE_MARKERS 兜底）。
// 按钮字是英文、不进词典（同诊断区，A20 只管汉字）。11-12 视口整块清理删掉不再用的可见高度探测（R-371 第二条路）、冷启动时间线（R-371）、
// 启动画面颜色诊断（台账 Q-2）、键盘上方输入辅助条诊断（台账 Q-11），Gap fix 的日志并进全局运行日志。现在两排：
// • Gap fix（R-371，platform/vh-gapfix.ts，iOS 主屏幕版默认开）：开关是“关掉用来对照”——默认 ON，点成 OFF 存本机，下次冷启动起不做（再点回 ON 恢复默认）；
//   每一步的日志在全局运行日志里（gapfix 开头的行）
// • Gap early / bar / kb / css（11-20 负责人选“手机上对照一次”）：治“少一截”的四套各自单独关掉对照（vh-gapfix-gate.ts 的 GapPart），默认 ON、点成 OFF 存本机，
//   下次冷启动起只停那一套；日志 gapfix start 行的 sw= 按 early bar kb css 记四位（1 开 0 关），各套生效时记量到的 gap 和生效后的 gap-after（对照步骤在本机资料 评审/2026-11-20_视口对照步骤.md）
// • Test haptic（R-471）：同一排，点一下震一下，按钮上写震动走的哪条路（switch：iOS 18 系统开关，触感由按钮里的 TapSwitch 出，和左滑“删除”同一套；
//   vibrate：navigator.vibrate；none：都没有）
// • Live speech（负责人 11-18 录屏“说话没有波动”，platform/speech.ts 的 liveSpeechOn）：默认 ON，点成 OFF 不走系统识别那一路、只用录音上传，
//   用来真机对照两条路（日志 voice hold start route=rec）
// • Finger switch（负责人 11-18“震动没反应”）：一个看得见的 iOS 系统开关 <input type="checkbox" switch>，让人用手指点：
//   手指点都不震 = 系统触感反馈关着或这台机器不支持，代码改不了；手指点震、Test haptic 不震 = TapSwitch 那套没接对。改变时记 probe finger switch on=
//   （11-18 iOS 26.6 真机：Finger switch 震，Haptic A / B / C 三种代点写法都不震——代点写法和这三个按钮已删）
// • 全局运行日志（platform/run-log.ts，非正式版一直在记）：“Send run log”一键发送、“Copy run log”整段复制、“Clear run log”清空
import { useState } from 'react';
import { FormButton } from '../../../kit/components/Form.tsx';
import { TapSwitch } from '../../../kit/components/TapSwitch.tsx';
import { tryHaptic, type HapticPath } from '../../../platform/feedback.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { liveSpeechOn, setLiveSpeechOn } from '../../../platform/speech.ts';
import { GAP_PARTS, gapFixOn, setGapFixOn, type GapPart } from '../../../platform/vh-gapfix-gate.ts';
import { clearRunLog, readRunLog } from '../../../platform/run-log.ts';
import { useRunLogSend, type RunLogSendState } from '../hooks/useRunLogSend.ts';
import styles from './SettingsPage.module.css';

/** 全局运行日志（platform/run-log.ts，非正式版一直在记） */
export const RL_COPY = 'Copy run log';
export const RL_COPIED = 'Copied';
export const RL_COPY_FAIL = 'Copy failed - try again';
export const RL_CLEAR = 'Clear run log';
/** 一键发送（features/settings/data/diag-send.ts → public.diag_logs，每人一行、新的覆盖旧的） */
export const RL_SEND = 'Send run log';
export const RL_SEND_LABEL: Record<Exclude<RunLogSendState, ''>, string> = {
  busy: 'Sending...',
  ok: 'Sent',
  signed_out: 'Send failed - sign in first',
  fail: 'Send failed - try again',
};
export const GF_LABEL_ON = 'Gap fix: ON';
export const GF_LABEL_OFF = 'Gap fix: OFF (compare)';
/** 四套各自的开关（按 GAP_PARTS 的顺序排一排） */
export const gapPartLabel = (part: GapPart, on: boolean): string => `Gap ${part}: ${on ? 'ON' : 'OFF (compare)'}`;
/** 试震动（R-471，platform/feedback.ts 的 tryHaptic；不看“声音和触感”开关）：按过以后写 Haptic: switch / vibrate / none */
export const HAP_TRY = 'Test haptic';
export const HAP_DONE = 'Haptic: ';
/** 录音时边说边出字的诊断开关（关掉用来对照） */
export const LS_LABEL_ON = 'Live speech: ON';
export const LS_LABEL_OFF = 'Live speech: OFF (compare)';
/** 手指点的系统开关 */
export const FS_LABEL = 'Finger switch';

/** 一套的开关：点一下翻转、存本机，按钮上照存下的值写 */
function GapPartButton({ part }: { readonly part: GapPart }) {
  const [on, setOn] = useState(() => gapFixOn(undefined, part));
  return (
    <FormButton
      size="compact"
      aria-pressed={on}
      data-testid={`vh-gap-${part}`}
      onClick={() => {
        setGapFixOn(!on, undefined, part);
        setOn(gapFixOn(undefined, part));
      }}
    >
      {gapPartLabel(part, on)}
    </FormButton>
  );
}

export function VhProbe() {
  const [gf, setGf] = useState(() => gapFixOn());
  const [hap, setHap] = useState<HapticPath | null>(null);
  const [ls, setLs] = useState(() => liveSpeechOn());
  const [rlCopied, setRlCopied] = useState<'' | 'ok' | 'fail'>('');
  const rlSend = useRunLogSend();
  /** 整段复制（按的时候重新读本机，记着的时候也拿最新的） */
  const copyRunLog = (): void => {
    try {
      void navigator.clipboard.writeText(readRunLog()).then(
        () => setRlCopied('ok'),
        () => setRlCopied('fail'),
      );
    } catch {
      setRlCopied('fail');
    }
  };
  return (
    <div data-testid="settings-vh-probe">
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
        {/* 在点按里同步震一下，按钮上写走的哪条路（R-471）；iOS 上由按钮里的真开关 TapSwitch 出触感，和左滑“删除”同一套 */}
        <FormButton size="compact" data-testid="vh-haptic" onClick={() => setHap(tryHaptic())}>
          {hap === null ? HAP_TRY : `${HAP_DONE}${hap}`}
          <TapSwitch />
        </FormButton>
      </div>
      <div className={`${styles.actions} ${styles.probeActions}`}>
        {GAP_PARTS.map((p) => (
          <GapPartButton key={p} part={p} />
        ))}
      </div>
      <div className={`${styles.actions} ${styles.probeActions}`}>
        <FormButton
          size="compact"
          aria-pressed={ls}
          data-testid="vh-live-speech"
          onClick={() => {
            setLiveSpeechOn(!ls);
            setLs(liveSpeechOn());
          }}
        >
          {ls ? LS_LABEL_ON : LS_LABEL_OFF}
        </FormButton>
        {/* switch 属性 React 不认识，挂上以后用 ref 补；不受控，只为让手指点一下看震不震 */}
        <label className={styles.probeSwitch}>
          <input
            type="checkbox"
            data-testid="vh-finger-switch"
            ref={(el) => el?.setAttribute('switch', '')}
            onChange={(e) => rlog(`probe finger switch on=${e.currentTarget.checked ? 1 : 0}`)}
          />
          {FS_LABEL}
        </label>
      </div>
      <div className={`${styles.actions} ${styles.probeActions}`}>
        <FormButton size="compact" data-testid="vh-rl-send" disabled={rlSend.state === 'busy'} onClick={rlSend.send}>
          {rlSend.state === '' ? RL_SEND : RL_SEND_LABEL[rlSend.state]}
        </FormButton>
        <FormButton size="compact" data-testid="vh-rl-copy" onClick={copyRunLog}>
          {rlCopied === 'ok' ? RL_COPIED : rlCopied === 'fail' ? RL_COPY_FAIL : RL_COPY}
        </FormButton>
        <FormButton
          size="compact"
          data-testid="vh-rl-clear"
          onClick={() => {
            clearRunLog();
            setRlCopied('');
            rlSend.reset();
          }}
        >
          {RL_CLEAR}
        </FormButton>
      </div>
    </div>
  );
}
