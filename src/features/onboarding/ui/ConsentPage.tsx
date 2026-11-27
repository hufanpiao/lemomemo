// 告知与同意页（视觉稿 PH.ainote、PH.ainoteko、SENDV）
// • 六行“会交给 AI 的东西”（“图片和附件”带“新”标签、不加粗）；隐私说明那一句（consent.privacy）单独醒目，紧接着 AI 服务商条款和 18 岁那一句；
//   再单独一块列出会送出去的东西和交给微软的；
// • “同意 AI 处理”勾选框默认不勾；没勾时“同意并继续”是 aria-disabled（仍可聚焦，读屏读得到为什么不能点），
//   “先不同意，直接用”随时可点；两个按钮都调 record_consent，请求落定前两个都点不了；
// • 失败留在本页、给一句提示，可以再点；no_policy 只给“继续使用”。
// variant="updated"：“隐私说明更新了”那一屏（视觉稿 PH.privupd、PH.privupdko）——同一套勾选、按钮和 record_consent，
//   换标题、四行“这次多了什么”、勾选句和“不同意”小字；隐私说明那一句照旧，不放首次那句条款（稿里没有）；data-step="policy-update"
// 底部隐私说明、条款链接：网页版新窗口打开；exe 里新窗口只放 https，相对地址打不开，点击时拼成本站绝对地址交给系统浏览器（kit/hooks/useOpenLink.ts）
// 接线：路由 #/onboarding 走 ui/ConsentRoute.tsx，启动关口走 ui/ConsentGate.tsx；ai.enabled 由接线方在 onDone(true) 里写（hooks/useConsentWiring.ts）
import { useId } from 'react';
import { Check, GroupLabel } from '../../../kit/components/Form.tsx';
import { sitePageClickHandler } from '../../../kit/hooks/useOpenLink.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { onlineNow, useConsent, type ConsentApi, type ConsentErr } from '../hooks/useConsent.ts';
import { useOnboardingT, type OnboardingMsgKey } from '../hooks/useOnboardingT.ts';
import styles from './ConsentPage.module.css';

export interface ConsentPageProps {
  api: ConsentApi;
  /** 服务器已记下：agreed=true 同意，false 不同意 */
  onDone: (agreed: boolean) => void;
  /** 会话被吊销或不在了：交给接线方按“被移除 / 没登录”处理（sid：被拒那次请求用的会话） */
  onRevoked: (sid: string | null) => void;
  /** 账号停用（account_disabled）：交给接线方清本机、回登录页（sid 同上） */
  onDisabled: (sid: string | null) => void;
  /** no_policy：这次没法保存选择，先不使用 AI 进 App，下次打开再问 */
  onSkip: () => void;
  /** first：首次告知页（默认）；updated：隐私说明更新了（noticeState 回 updated） */
  variant?: 'first' | 'updated';
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

// PH.privupd：只列这次多出来的四样（“新”标签同上）
const UPDATE_ITEMS = [
  ['consent.item.media', 'consent.update.item.media.d', true],
  ['consent.item.plus', 'consent.update.item.plus.d', false],
  ['consent.item.cal', 'consent.update.item.cal.d', true],
  ['consent.update.item.ppt', 'consent.update.item.ppt.d', false],
] as const satisfies readonly (readonly [OnboardingMsgKey, OnboardingMsgKey, boolean])[];

const COPY = {
  first: {
    step: 'consent', title: 'consent.title', lead: 'consent.lead', items: ITEMS, itemsLabel: 'consent.itemsLabel', terms: true,
    check: 'consent.check', declineNote: 'consent.declineNote',
  },
  updated: {
    step: 'policy-update', title: 'consent.update.title', lead: 'consent.update.lead', items: UPDATE_ITEMS, itemsLabel: 'consent.update.itemsLabel', terms: false,
    check: 'consent.update.check', declineNote: 'consent.update.declineNote',
  },
} as const;

export default function ConsentPage({ api, onDone, onRevoked, onDisabled, onSkip, variant = 'first' }: ConsentPageProps) {
  const t = useOnboardingT();
  const c = COPY[variant];
  const ko = useUi((s) => s.locale) === 'ko-KR';
  const needId = useId();
  const { checked, setChecked, busy, slow, err, submit, skip } = useConsent(api, { onDone, onRevoked, onDisabled, onSkip });
  const blocked = err === 'no_policy';
  // 视觉稿：韩文标签和正文之间空一格，中文是全角冒号、不空
  const sep = ko ? ' ' : '';

  return (
    <main className={styles.page} data-feature="onboarding" data-step={c.step} aria-busy={busy}>
      <h1 className={styles.title}>{t(c.title, {})}</h1>
      <p className={styles.lead}>{t(c.lead, {})}</p>

      {/* 清单上方的小字分组名（kit GroupLabel），清单和标题之间多一层 */}
      <div>
        <GroupLabel>{t(c.itemsLabel, {})}</GroupLabel>
        <ul className={styles.items} data-testid="consent-items">
          {c.items.map(([k, d, isNew]) => (
            <li key={k} className={styles.item}>
              <span className={styles.itemTitle}>
                {t(k, {})}
                {isNew && <span className={styles.newTag}>{t('consent.newTag', {})}</span>}
              </span>
              <span className={styles.itemDesc}>{t(d, {})}</span>
            </li>
          ))}
        </ul>
      </div>

      <section className={styles.panel} data-testid="consent-notice">
        <p className={styles.privacy} data-testid="consent-privacy">
          {t('consent.privacy', {})}
        </p>
        {c.terms && <p className={styles.terms}>{t('consent.terms', {})}</p>}
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

      {/* 勾选框用 kit 的 Check look="circle"（全 App 同一个圆角方框、同一个打勾动效），不用系统方框 */}
      <div className={styles.agree}>
        <Check look="circle" label={t(c.check, {})} checked={checked} disabled={busy || blocked} onChange={setChecked} />
      </div>

      {err && err !== 'revoked' && err !== 'disabled' && (
        <p className={styles.hint} role="alert" data-testid="consent-error" data-error={err}>
          {t(err === 'offline' && onlineNow() ? 'consent.err.unreachable' : ERR_KEY[err], {})}
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
          <p className={styles.note}>{t(c.declineNote, {})}</p>
        </>
      )}

      <p className={styles.links}>
        {ko ? (
          <>
            <a href="/ko/privacy" target="_blank" rel="noopener noreferrer" onClick={sitePageClickHandler('/ko/privacy')}>{t('consent.privacyLink', {})}</a>
            <a href="/ko/terms" target="_blank" rel="noopener noreferrer" onClick={sitePageClickHandler('/ko/terms')}>{t('consent.termsLink', {})}</a>
          </>
        ) : (
          <>
            <a href="/zh/privacy" target="_blank" rel="noopener noreferrer" onClick={sitePageClickHandler('/zh/privacy')}>{t('consent.privacyLink', {})}</a>
            <a href="/zh/terms" target="_blank" rel="noopener noreferrer" onClick={sitePageClickHandler('/zh/terms')}>{t('consent.termsLink', {})}</a>
          </>
        )}
      </p>
    </main>
  );
}
