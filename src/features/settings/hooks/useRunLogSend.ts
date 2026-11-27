// 诊断面板“Send run log”的状态（data/diag-send.ts 发，页面只管显示）：'' 没发过、busy 发送中、其余是上一次的结果
import { useCallback, useState } from 'react';
import { readRunLog } from '../../../platform/run-log.ts';
import { sendRunLog, type DiagSendResult } from '../data/diag-send.ts';

export type RunLogSendState = '' | 'busy' | DiagSendResult;

export function useRunLogSend(send: (log: string) => Promise<DiagSendResult> = sendRunLog): {
  state: RunLogSendState;
  send: () => void;
  reset: () => void;
} {
  const [state, setState] = useState<RunLogSendState>('');
  const go = useCallback(() => {
    setState('busy');
    void send(readRunLog()).then(setState);
  }, [send]);
  const reset = useCallback(() => setState(''), []);
  return { state, send: go, reset };
}
