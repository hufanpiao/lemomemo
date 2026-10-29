// 注销冷静期的恢复页、“账号已停用”、“暂时无法确认账号状态”（R-256 ③、R-258、架构 0.29 续第 131 条④、第 134 条；TC-B1-100、103）
// 恢复页：“账号在注销冷静期，<日期 时刻> 后彻底删除。恢复吗？”（purge_after 为 null 时换不带日期的那句），“恢复账号”“保持注销并退出”
// 停用页：auth.exit.disabled 一句和“回到登录”，不出现恢复提示（需求澄清 2.21 第 120 行）；退出、清本机做完以前只显示“请稍候…”
// 无法确认（只在验证码刚通过时出现，R-258）：“重试”重新探测，“仍然进入”照旧进 App；不清本机
import type { AccountGate, GateErr } from '../hooks/useAccountGate.ts';
import { useAuthT, type AuthPlainKey } from '../hooks/useAuthT.ts';
import styles from './AuthPage.module.css';

const ERR_KEYS = {
  restore_too_late: 'auth.restore.err.tooLate',
  rate_limited: 'auth.restore.err.rateLimited',
  try_later: 'auth.restore.err.tryLater',
  offline: 'auth.restore.err.offline',
  unknown: 'auth.restore.err.unknown',
} as const satisfies Record<GateErr, AuthPlainKey>;

export interface AccountGatePanelProps {
  gate: AccountGate;
  /** 恢复成功后进 App */
  onRestored: () => void;
  /** “仍然进入”、重试通过后进 App（只有验证码刚通过那条路会用到） */
  onEnter?: () => void;
}

export function AccountGatePanel({ gate, onRestored, onEnter = onRestored }: AccountGatePanelProps) {
  const t = useAuthT();
  if (gate.view === 'disabled') {
    if (gate.busy) {
      return (
        <p className={styles.lead} role="status" data-testid="auth-disabled-busy">
          {t('auth.busy', {})}
        </p>
      );
    }
    return (
      <div className={styles.form}>
        <p className={styles.notice} role="alert" data-testid="auth-disabled">
          {t('auth.exit.disabled', {})}
        </p>
        <button className={styles.link} type="button" onClick={gate.backToLogin}>
          {t('auth.gate.backToLogin', {})}
        </button>
      </div>
    );
  }
  if (gate.view === 'unsure') {
    return (
      <div className={styles.form} data-testid="auth-unsure">
        <p className={styles.notice} role="alert">
          {t('auth.gate.unsure', {})}
        </p>
        <button className={styles.primary} type="button" disabled={gate.busy} onClick={() => void gate.retry(onEnter)}>
          {gate.busy ? t('auth.busy', {}) : t('auth.gate.retry', {})}
        </button>
        <button className={styles.link} type="button" disabled={gate.busy} onClick={() => gate.enter(onEnter)}>
          {t('auth.gate.enterAnyway', {})}
        </button>
      </div>
    );
  }
  const when = gate.when ? t('auth.restore.when', gate.when) : null;
  const tooLate = gate.error === 'restore_too_late';
  return (
    <div className={styles.form} data-testid="auth-restore">
      <p className={styles.lead} data-testid="auth-restore-ask">
        {when ? t('auth.restore.ask', { when }) : t('auth.restore.askNoDate', {})}
      </p>
      {gate.error && (
        <p className={styles.hint} role="alert" data-testid="auth-restore-error" data-error={gate.error}>
          {t(ERR_KEYS[gate.error], {})}
        </p>
      )}
      {!tooLate && (
        <button className={styles.primary} type="button" disabled={gate.busy} onClick={() => void gate.restore(onRestored)}>
          {gate.busy ? t('auth.busy', {}) : t('auth.restore.restore', {})}
        </button>
      )}
      <button className={styles.link} type="button" disabled={gate.busy} onClick={() => void gate.keep()}>
        {t('auth.restore.keep', {})}
      </button>
    </div>
  );
}
