// 设置页骨架（B1 K9；TC-B1-18、TC-B1-19；定稿线框 s13）
// 本批只有：中韩切换、已登录设备（移除、退出其他所有设备、另有 N 个登录）、导出和注销的入口（K3 做，现在“即将开放”）、退出登录。
// 其余分组（皮肤、提醒与通知、语音与 AI、隐私记、时区、数据……）由各功能在后面的批次按 features.ts 登记接进来
import { useRef, useState } from 'react';
import { hrefOf } from '../../../app/router.ts';
import { Dialog } from '../../../kit/components/Dialog.tsx';
import { Pressable } from '../../../motion/components.ts';
import { useSettingsPage, type ExitNotice, type SettingsDeps } from '../hooks/useSettingsPage.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { DevicesSection } from './DevicesSection.tsx';
import styles from './SettingsPage.module.css';

type Page = ReturnType<typeof useSettingsPage>;

function LanguageSection({ locale }: { locale: Page['locale'] }) {
  const t = useSettingsT();
  return (
    <section aria-labelledby="settings-lang-title">
      <ul className={styles.grp}>
        <li className={styles.row}>
          <h2 id="settings-lang-title" className={styles.tx}>
            {t('settings.lang.title', {})}
          </h2>
          <div className={styles.seg} role="group" aria-labelledby="settings-lang-title" data-testid="settings-lang">
            {(['zh', 'ko'] as const).map((l) => (
              <Pressable
                key={l}
                className={styles.segBtn}
                lang={l === 'ko' ? 'ko' : 'zh'}
                aria-pressed={locale.current === l}
                data-locale={l}
                onClick={() => void locale.choose(l)}
              >
                {t(l === 'ko' ? 'settings.lang.ko' : 'settings.lang.zh', {})}
              </Pressable>
            ))}
          </div>
        </li>
      </ul>
      <p className={styles.sn}>{t('settings.lang.note', {})}</p>
      {locale.sync === 'failed' ? (
        <p className={styles.error} role="alert">
          {t('settings.lang.syncFailed', {})}
        </p>
      ) : null}
    </section>
  );
}

/** 导出、注销只放入口（K3 后面做）：按钮禁用，旁边写“即将开放”。退出登录交给页面的 askSignOut（先数没上传的） */
function AccountSection({ busy, signingOut, onSignOut }: { busy: boolean; signingOut: boolean; onSignOut(): void }) {
  const t = useSettingsT();
  const soon = t('settings.soon', {});
  return (
    <section aria-labelledby="settings-account-title">
      <h2 id="settings-account-title" className={styles.gt}>
        {t('settings.account.title', {})}
      </h2>
      <ul className={styles.grp}>
        {(['settings.account.export', 'settings.account.delete'] as const).map((key) => (
          <li key={key} className={styles.row}>
            <Pressable className={`${styles.btn} ${styles.tx}`} disabled aria-disabled data-testid={key} aria-describedby={`${key}-soon`}>
              {t(key, {})}
            </Pressable>
            <span id={`${key}-soon`} className={styles.v}>
              {soon}
            </span>
          </li>
        ))}
      </ul>
      <Pressable
        className={`${styles.btn} ${styles.wide}`}
        disabled={busy || signingOut}
        aria-busy={signingOut}
        onClick={onSignOut}
        data-testid="settings-signout"
      >
        {t('settings.account.signOut', {})}
      </Pressable>
      {/* 点了退出到跳走最长约 16 秒（删行、signOut 共 8 秒，清本机库和缓存另有上限）：一直写着“正在退出…”；状态区常驻，读屏才会播报 */}
      <p className={styles.status} role="status" data-testid="settings-signing-out">
        {signingOut ? t('settings.signingOut', {}) : ''}
      </p>
    </section>
  );
}

/** 退出这台设备前的确认：从“退出登录”来、且确定没有没上传的，直接退；其余都问一次 */
type Ask = { n: number | null; from: 'account' | 'device' } | null;

function SignOutConfirm({ ask, onOk, onCancel }: { ask: Ask; onOk(): void; onCancel(): void }) {
  const t = useSettingsT();
  const n = ask?.n ?? null;
  // 数出来是 0（只会从设备列表来）：原来的“退出这台设备？”；有没上传的：写条数；数不出来：写“可能有”
  const plain = n === 0;
  return (
    <ConfirmDialog
      open={ask !== null}
      danger
      title={
        plain
          ? t('settings.confirm.removeThis.title', {})
          : n === null
            ? t('settings.confirm.signOut.unknownTitle', {})
            : t('settings.confirm.signOut.title', { n })
      }
      body={plain ? t('settings.confirm.removeThis.body', {}) : t('settings.confirm.signOut.body', {})}
      okLabel={plain ? t('settings.confirm.removeThis.ok', {}) : t('settings.confirm.signOut.ok', {})}
      cancelLabel={t('settings.cancel', {})}
      onOk={onOk}
      onCancel={onCancel}
    />
  );
}

const EXIT_TEXT = {
  revoked: { title: 'settings.revoked.title', body: 'settings.revoked.body' },
  signed_out: { title: 'settings.signedOut.title', body: 'settings.signedOut.body' },
  offline_signout: { title: 'settings.offlineOut.title', body: 'settings.offlineOut.body' },
} as const satisfies Record<ExitNotice, { title: string; body: string }>;

/** 离开本机前的提示（被移除、别处已退出、服务器没退成）：不能关，只能去登录（几秒后也会自动去）；本机还没清完时按钮禁用 */
function ExitDialog({ notice, cleaning, onGo }: { notice: ExitNotice | null; cleaning: boolean; onGo(): void }) {
  const t = useSettingsT();
  const text = EXIT_TEXT[notice ?? 'revoked'];
  return (
    <Dialog open={notice !== null} onOpenChange={() => undefined} title={t(text.title, {})} description={t(text.body, {})}>
      <div className={styles.actions}>
        <Pressable className={styles.primary} onClick={onGo} disabled={cleaning} aria-busy={cleaning} data-testid="settings-revoked-go">
          {cleaning ? t('settings.busy', {}) : t('settings.revoked.go', {})}
        </Pressable>
      </div>
    </Dialog>
  );
}

export default function SettingsPage({ deps }: { deps?: SettingsDeps } = {}) {
  const t = useSettingsT();
  const page = useSettingsPage(deps);
  const { exit, devices, locale } = page;
  const [ask, setAsk] = useState<Ask>(null);
  const counting = useRef(false);

  /** 先数没上传的（离线队列 + 草稿，先重新读库，别的标签页的也算上），再决定直接退还是先问 */
  const askSignOut = async (from: 'account' | 'device'): Promise<void> => {
    if (counting.current) return;
    counting.current = true;
    let n: number | null;
    try {
      n = await exit.pendingCount();
    } catch {
      n = null;
    }
    counting.current = false;
    if (n === 0 && from === 'account') void devices.signOutThis();
    else setAsk({ n, from });
  };
  return (
    <main className={styles.page} data-feature="settings" aria-busy={devices.busy !== null}>
      <header className={styles.top}>
        <a className={styles.back} href={hrefOf('today')}>
          ‹ {t('settings.back', {})}
        </a>
        <h1 className={styles.title}>{t('settings.title', {})}</h1>
      </header>
      <LanguageSection locale={locale} />
      <DevicesSection devices={devices} onExitHere={() => void askSignOut('device')} />
      <AccountSection busy={devices.busy !== null} signingOut={exit.signingOut} onSignOut={() => void askSignOut('account')} />
      <SignOutConfirm
        ask={ask}
        onOk={() => {
          setAsk(null);
          void devices.signOutThis();
        }}
        onCancel={() => setAsk(null)}
      />
      <ExitDialog notice={exit.notice} cleaning={exit.cleaning} onGo={exit.goToAuth} />
    </main>
  );
}
