// 设置页骨架（B1 K9；TC-B1-18、TC-B1-19、TC-B1-71；定稿线框 s13；R-256 ①）
// 分组顺序只看 data/sections.ts 的固定表：账号（已登录设备、退出其他所有设备、注销入口）→ 界面语言 → 数据（导出全部）；
// 其余分组（皮肤、提醒与通知、语音与 AI、隐私记、时区……）由各功能在后面的批次按表里的位置接进来。
// “退出登录”不是分组：页面最底下单独一行，永远在所有分组之后。
// 注销账号是本页里的另一屏（view = 'delete'），离开本机的提示框两屏都在
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { hrefOf } from '../../../app/router.ts';
import { Dialog } from '../../../kit/components/Dialog.tsx';
import { Pressable } from '../../../motion/components.ts';
import { orderSections, useSettingsPage, type ExitNotice, type SettingsDeps, type SettingsSectionId } from '../hooks/useSettingsPage.ts';
import { useRecentExport } from '../hooks/useRecentExport.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import { AccountSection } from './AccountSection.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { DataSection } from './DataSection.tsx';
import { DeleteAccountView } from './DeleteAccountView.tsx';
import { LanguageSection } from './LanguageSection.tsx';
import styles from './SettingsPage.module.css';

/** 页面最底下的“退出登录”（交给页面的 askSignOut，先数没上传的） */
function SignOutRow({ busy, signingOut, onSignOut }: { busy: boolean; signingOut: boolean; onSignOut(): void }) {
  const t = useSettingsT();
  return (
    <div className={styles.bottom}>
      <Pressable
        className={`${styles.btn} ${styles.wide}`}
        disabled={busy || signingOut}
        aria-busy={signingOut}
        onClick={onSignOut}
        data-testid="settings-signout"
      >
        {t('settings.account.signOut', {})}
      </Pressable>
      {/* 点了退出到跳走最长约 19 秒（删行、signOut 共 8 秒，清本机库、缓存、最后再删一次库另有上限）：一直写着“正在退出…”；状态区常驻，读屏才会播报 */}
      <p className={styles.status} role="status" data-testid="settings-signing-out">
        {signingOut ? t('settings.signingOut', {}) : ''}
      </p>
    </div>
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
  const { exit, devices, locale, account, recentExports } = page;
  /** 本页导出成功一次加 1：最近的导出重读 */
  const [exportTick, setExportTick] = useState(0);
  const recent = useRecentExport(recentExports, exportTick);
  const [ask, setAsk] = useState<Ask>(null);
  const [view, setView] = useState<'home' | 'delete'>('home');
  const nowFn = deps?.now ?? Date.now;
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
  const bumpExport = useCallback(() => setExportTick((n) => n + 1), []);
  const sections: Partial<Record<SettingsSectionId, ReactNode>> = {
    account: (
      <AccountSection
        devices={devices}
        recent={recent}
        email={page.email}
        onExitHere={() => void askSignOut('device')}
        onDelete={() => setView('delete')}
      />
    ),
    language: <LanguageSection locale={locale} />,
    data: <DataSection account={account} onExported={bumpExport} />,
  };
  return (
    <main className={styles.page} data-feature="settings" aria-busy={devices.busy !== null}>
      {view === 'delete' ? (
        <DeleteAccountView account={account} pendingCount={exit.pendingCount} now={nowFn} onBack={() => setView('home')} />
      ) : (
        <>
          <header className={styles.top}>
            <a className={styles.back} href={hrefOf('today')}>
              ‹ {t('settings.back', {})}
            </a>
            <h1 className={styles.title}>{t('settings.title', {})}</h1>
          </header>
          <div className={styles.groups}>
            {orderSections(sections).map(([id, node]) => (
              <div key={id} className={styles.slot} data-section-slot={id}>
                {node}
              </div>
            ))}
          </div>
          <SignOutRow busy={devices.busy !== null} signingOut={exit.signingOut} onSignOut={() => void askSignOut('account')} />
        </>
      )}
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
