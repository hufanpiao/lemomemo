// 非正式版诊断区的按钮（AboutSection 在设置 › 关于的诊断打开时挂；正式构建靠 MODE 常量摇掉，build/check_no_probe.mjs 的 PROBE_MARKERS 兜底）。
// 按钮字是英文、不进词典（同诊断区，A20 只管汉字）。11-12 视口整块清理删掉不再用的可见高度探测（R-371 第二条路）、冷启动时间线（R-371）、
// 启动画面颜色诊断（台账 Q-2）、键盘上方输入辅助条诊断（台账 Q-11），Gap fix 的日志并进全局运行日志。现在两排：
// • Gap fix（R-371，platform/vh-gapfix.ts，iOS 主屏幕版默认开）：开关是“关掉用来对照”——默认 ON，点成 OFF 存本机，下次冷启动起不做（再点回 ON 恢复默认）；
//   每一步的日志在全局运行日志里（gapfix 开头的行）
// • 全局运行日志（platform/run-log.ts，非正式版一直在记）：“Send run log”一键发送、“Copy run log”整段复制、“Clear run log”清空
import { useState } from 'react';
import { FormButton } from '../../../kit/components/Form.tsx';
import { gapFixOn, setGapFixOn } from '../../../platform/vh-gapfix.ts';
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

export function VhProbe() {
  const [gf, setGf] = useState(() => gapFixOn());
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
