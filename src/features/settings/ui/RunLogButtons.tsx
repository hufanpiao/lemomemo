// 设置 › 关于 诊断区的运行日志三个按钮：“Send run log”一键发到 public.diag_logs（每人一行、新的覆盖旧的）、“Copy run log”整段复制、“Clear run log”清空。
// 11-28 负责人贴正式版诊断问“为啥关于没有发送log跟复制log”，弹窗选“正式版也带”：运行日志正式版也常开（platform/run-log-api.ts 的 RLOG_ON），
// 这三个按钮从 VhProbe（只进非正式版的试验开关）里挪出来，AboutSection 在诊断开着时一律挂；试验开关照旧只在非正式版。
// 按钮字是英文、不进词典（同诊断区，A20 只管汉字）
import { useState } from 'react';
import { FormButton } from '../../../kit/components/Form.tsx';
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
export function RunLogButtons() {
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
    <div className={`${styles.actions} ${styles.probeActions}`} data-testid="settings-run-log">
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
  );
}
