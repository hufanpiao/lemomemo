// 设置 › 账号 › 注销账号
// • 正文四句：会删什么、7 天冷静期（删除日期写“日期 + 时刻”）、满 7 天后不能恢复、只发邮件请留意垃圾邮件
// • 打开时数没上传的（和退出登录确认框同一个 pendingCount）：有就提示“还有 N 条改动没上传，注销后会丢弃”，数不出来写“可能有”
// • 手打确认词：中文界面“注销”、韩文界面“탈퇴”（词典 settings.delete.word，和界面语言一致）；去掉首尾空白后完全相同才可提交。
//   输入法组字期间（compositionstart 到 compositionend）一律不可提交，组完字再判断；没有验证码框
// • 提交 account delete，成功后离开本机（core/account-leave.ts），不调 signOut、不删 devices 行
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useUi } from '../../../kit/state/ui-store.ts';
import { FormButton } from '../../../kit/components/Form.tsx';
import form from '../../../kit/components/Form.module.css';
import { BackLink } from '../../../kit/components/BackLink.tsx';
import { useDeleteAccount, type AccountActionDeps } from '../hooks/useAccountActions.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import { accountErrText } from './AccountSection.tsx';
import { fmtWhen } from './DevicesSection.tsx';
import styles from './SettingsPage.module.css';

/** 冷静期：purge_after = 申请时刻 + 7 天 */
export const COOLING_MS = 7 * 24 * 60 * 60 * 1000;

export interface DeleteViewProps {
  account: AccountActionDeps;
  pendingCount(): Promise<number | null>;
  now(): number;
  onBack(): void;
}

export function DeleteAccountView({ account, pendingCount, now, onBack }: DeleteViewProps) {
  const t = useSettingsT();
  const locale = useUi((s) => s.locale);
  const { state, unsent, submit } = useDeleteAccount(account, pendingCount);
  const [value, setValue] = useState('');
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [opened] = useState(now);
  const word = t('settings.delete.word', {});
  const busy = state.kind === 'busy';
  const matches = (v: string): boolean => v.trim() === word;
  const canSubmit = !composing && !busy && matches(value);

  useEffect(() => titleRef.current?.focus(), []);

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    // 回车可能在组字中途触发：再按 ref 判断一次
    if (composingRef.current || busy || !matches(value)) return;
    void submit(value);
  };

  return (
    <>
      <header className={styles.top}>
        <BackLink label={t('settings.delete.back', {})} onBack={onBack} disabled={busy} testId="settings-delete-back" />
        <h1 className={styles.title} ref={titleRef} tabIndex={-1}>
          {t('settings.account.delete', {})}
        </h1>
      </header>
      <section aria-labelledby="settings-delete-title" data-testid="settings-delete">
        <h2 id="settings-delete-title" className={styles.srOnly}>
          {t('settings.account.delete', {})}
        </h2>
        <div className={styles.card}>
          <p className={styles.para}>{t('settings.delete.body.what', {})}</p>
          <p className={styles.para} data-testid="settings-delete-cooling">
            {t('settings.delete.body.cooling', { date: fmtWhen(opened + COOLING_MS, locale) })}
          </p>
          <p className={styles.para}>{t('settings.delete.body.final', {})}</p>
          <p className={styles.para}>{t('settings.delete.body.mail', {})}</p>
        </div>
        {unsent === null || (typeof unsent === 'number' && unsent > 0) ? (
          <p className={styles.error} data-testid="settings-delete-unsent">
            {unsent === null ? t('settings.delete.unsentUnknown', {}) : t('settings.delete.unsent', { n: unsent })}
          </p>
        ) : null}
        <form className={styles.form} onSubmit={onSubmit} noValidate>
          <label className={styles.label} htmlFor="settings-delete-input">
            {t('settings.delete.label', { word })}
          </label>
          <input
            id="settings-delete-input"
            className={`${form.input} ${styles.input}`}
            value={value}
            disabled={busy}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="done"
            onChange={(e) => setValue(e.currentTarget.value)}
            onCompositionStart={() => {
              composingRef.current = true;
              setComposing(true);
            }}
            onCompositionEnd={(e) => {
              composingRef.current = false;
              setComposing(false);
              setValue(e.currentTarget.value);
            }}
            data-testid="settings-delete-input"
          />
          {/* 按钮用 compact dangerFill block；多出来的上边距和“没输对时灰底灰字”放在外面这层 .full 上（SettingsPage.module.css） */}
          <div className={styles.full}>
            <FormButton
              type="submit"
              size="compact"
              variant="dangerFill"
              block
              disabled={!canSubmit}
              aria-busy={busy}
              data-testid="settings-delete-submit"
              data-no-proxy=""
            >
              {t('settings.delete.submit', {})}
            </FormButton>
          </div>
        </form>
        <p className={styles.status} role="status">
          {busy ? t('settings.delete.busy', {}) : ''}
        </p>
        {state.kind === 'error' ? (
          <p className={styles.error} role="alert">
            {accountErrText(state.error, t)}
          </p>
        ) : null}
      </section>
    </>
  );
}
