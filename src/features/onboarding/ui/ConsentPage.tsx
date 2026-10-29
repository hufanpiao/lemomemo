// 告知与同意页（架构 15.5、R-103、R-115、0.40 R-239、R-240；视觉稿 PH.ainote、PH.ainoteko、SENDV；TC-B1-11）
// • 六行“会交给 AI 的东西”（“图片和附件”带“新”标签、不加粗，R-138）；R-115 的句子单独醒目，紧接着谷歌免费版条款和 18 岁那一句；
//   再单独一块列出会送出去的东西和交给微软的（15.5）；
// • “同意 AI 处理”勾选框默认不勾（R-103）；没勾时“同意并继续”是 aria-disabled（仍可聚焦，读屏读得到为什么不能点），
//   “先不同意，直接用”随时可点；两个按钮都调 record_consent，请求落定前两个都点不了；
// • 失败留在本页、给一句提示，可以再点；no_policy（R-239）只给“继续使用”。
// 接线（CONSENT-wire）：路由 #/onboarding 走 ui/ConsentRoute.tsx，启动关口走 ui/ConsentGate.tsx；ai.enabled 由接线方在 onDone(true) 里写（hooks/useConsentWiring.ts）
import { useId } from 'react';
import { useUi } from '../../../kit/state/ui-store.ts';
import { useConsent, type ConsentApi, type ConsentErr } from '../hooks/useConsent.ts';
import { useOnboardingT, type OnboardingMsgKey } from '../hooks/useOnboardingT.ts';
import styles from './ConsentPage.module.css';

export interface ConsentPageProps {
  api: ConsentApi;
  /** 服务器已记下：agreed=true 同意，false 不同意 */
  onDone: (agreed: boolean) => void;
  /** 会话被吊销或不在了：交给接线方按“被移除 / 没登录”处理 */
  onRevoked: () => void;
  /** 账号停用（account_disabled）：交给接线方按架构 4.3 清本机、回登录页 */
  onDisabled: () => void;
  /** R-239：这次没法保存选择，先不使用 AI 进 App，下次打开再问 */
  onSkip: () => void;
}

const ERR_KEY: Record<Exclude<ConsentErr, 'revoked' | 'disabled'>, OnboardingMsgKey> = {
  offline: 'consent.err.offline',
  version_changed: 'consent.err.version',
  no_policy: 'consent.err.noPolicy',
  unsure: 'consent.err.unsure',
  try_later: 'consent.err.tryLater',
  unknown: 'consent.err.unknown',
};

const ITEMS = [
  ['consent.item.voice', 'consent.item.voice.d', false],
  ['consent.item.note', 'consent.item.note.d', false],
  ['consent.item.media', 'consent.item.media.d', true],
  ['consent.item.plus', 'consent.item.plus.d', false],
  ['consent.item.cal', 'consent.item.cal.d', false],
  ['consent.item.vault', 'consent.item.vault.d', false],
] as const satisfies readonly (readonly [OnboardingMsgKey, OnboardingMsgKey, boolean])[];

export default function ConsentPage({ api, onDone, onRevoked, onDisabled, onSkip }: ConsentPageProps) {
  const t = useOnboardingT();
  const ko = useUi((s) => s.locale) === 'ko-KR';
  const checkId = useId();
  const needId = useId();
  const { checked, setChecked, busy, slow, err, submit, skip } = useConsent(api, { onDone, onRevoked, onDisabled, onSkip });
  const blocked = err === 'no_policy';
  // 视觉稿：韩文标签和正文之间空一格，中文是全角冒号、不空
  const sep = ko ? ' ' : '';

  return (
    <main className={styles.page} data-feature="onboarding" data-step="consent" aria-busy={busy}>
      <h1 className={styles.title}>{t('consent.title', {})}</h1>
      <p className={styles.lead}>{t('consent.lead', {})}</p>

      <ul className={styles.items} data-testid="consent-items">
        {ITEMS.map(([k, d, isNew]) => (
          <li key={k} className={styles.item}>
            <span className={styles.itemTitle}>
              {t(k, {})}
              {isNew && <span className={styles.newTag}>{t('consent.newTag', {})}</span>}
            </span>
            <span className={styles.itemDesc}>{t(d, {})}</span>
          </li>
        ))}
      </ul>

      <section className={styles.panel} data-testid="consent-notice">
        <p className={styles.privacy} data-testid="consent-privacy">
          {t('consent.privacy', {})}
        </p>
        <p className={styles.terms}>{t('consent.terms', {})}</p>
      </section>

      <section className={styles.panel} data-testid="consent-send">
        <p className={styles.terms}>
          <span className={styles.sendLabel}>{t('consent.send.label', {})}</span>
          {sep}
          {t('consent.send.body', {})}
          {sep}
          <span className={styles.sendLabel}>{t('consent.send.msLabel', {})}</span>
          {sep}
          {t('consent.send.msBody', {})}
        </p>
      </section>

      <div className={styles.agree}>
        <input
          id={checkId}
          className={styles.check}
          type="checkbox"
          checked={checked}
          disabled={busy || blocked}
          onChange={(e) => setChecked(e.currentTarget.checked)}
        />
        <label htmlFor={checkId}>{t('consent.check', {})}</label>
      </div>

      {err && err !== 'revoked' && err !== 'disabled' && (
        <p className={styles.hint} role="alert" data-testid="consent-error" data-error={err}>
          {t(ERR_KEY[err], {})}
        </p>
      )}
      {slow && (
        <p className={styles.note} role="status" data-testid="consent-slow">
          {t('consent.slow', {})}
        </p>
      )}

      {blocked ? (
        <button className={styles.primary} type="button" onClick={skip}>
          {t('consent.continue', {})}
        </button>
      ) : (
        <>
          <button
            className={styles.primary}
            type="button"
            disabled={busy}
            aria-disabled={!checked || busy}
            aria-describedby={checked ? undefined : needId}
            onClick={() => void submit(true)}
          >
            {busy ? t('consent.busy', {}) : t('consent.agree', {})}
          </button>
          {!checked && (
            <p id={needId} className={styles.note}>
              {t('consent.needCheck', {})}
            </p>
          )}
          <button className={styles.secondary} type="button" disabled={busy} onClick={() => void submit(false)}>
            {t('consent.decline', {})}
          </button>
          <p className={styles.note}>{t('consent.declineNote', {})}</p>
        </>
      )}

      <p className={styles.links}>
        {ko ? (
          <>
            <a href="/ko/privacy" target="_blank" rel="noopener noreferrer">{t('consent.privacyLink', {})}</a>
            <a href="/ko/terms" target="_blank" rel="noopener noreferrer">{t('consent.termsLink', {})}</a>
          </>
        ) : (
          <>
            <a href="/zh/privacy" target="_blank" rel="noopener noreferrer">{t('consent.privacyLink', {})}</a>
            <a href="/zh/terms" target="_blank" rel="noopener noreferrer">{t('consent.termsLink', {})}</a>
          </>
        )}
      </p>
    </main>
  );
}
