// 设置 › 账号（R-256 ①，排第一）：已登录设备、退出其他所有设备（DevicesSection）、注销入口。
// “最近的导出”（R-256 ②）在设备列表和注销入口之间；“退出登录”不在这里，在页面最底下单独一行
import type { AccountErr } from '../hooks/useAccountActions.ts';
import type { useDevices } from '../hooks/useDevices.ts';
import type { RecentExportState } from '../hooks/useRecentExport.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import { Pressable } from '../../../motion/components.ts';
import { DevicesSection } from './DevicesSection.tsx';
import { RecentExport } from './RecentExport.tsx';
import styles from './SettingsPage.module.css';

type T = ReturnType<typeof useSettingsT>;

/**
 * 导出、注销失败时的那一句（会话没了、停用、冷静期另走离开本机，不显示）。
 * 穷尽 switch、不写 default（R272-sugg ④，架构 0.29 续第 119 条②）：try_later 单独一支“服务器忙，稍后再试”；加了新码不补分支就编译不过
 */
export function accountErrText(e: AccountErr, t: T): string {
  switch (e) {
    case 'rate_limited':
      return t('settings.account.rateLimited', {});
    // 临时故障：只提示，不清本机、不回登录页（TC-B1-90）
    case 'try_later':
      return t('settings.err.tryLater', {});
    case 'offline':
      return t('settings.err.offline', {});
    case 'confirm_required':
      return t('settings.delete.confirmRequired', { word: t('settings.delete.word', {}) });
    case 'admin_cannot_delete':
      return t('settings.delete.admin', {});
    case 'account_disabled':
      return t('settings.err.accountDisabled', {});
    case 'revoked':
    case 'signed_out':
    case 'pending_deletion':
    case 'unknown':
      return t('settings.err.unknown', {});
  }
}

export function AccountSection({
  devices, recent, onExitHere, onDelete,
}: { devices: ReturnType<typeof useDevices>; recent: RecentExportState; onExitHere(): void; onDelete(): void }) {
  const t = useSettingsT();
  return (
    <section aria-labelledby="settings-account-title" data-section="account">
      <h2 id="settings-account-title" className={styles.gt}>
        {t('settings.account.title', {})}
      </h2>
      <DevicesSection devices={devices} onExitHere={onExitHere} />
      <RecentExport state={recent} devices={devices.state} />
      <ul className={`${styles.grp} ${styles.gap}`}>
        <li className={styles.row}>
          <Pressable
            className={`${styles.rowBtn} ${styles.danger}`}
            disabled={devices.busy !== null}
            onClick={onDelete}
            data-testid="settings-delete-entry"
          >
            <span className={styles.tx}>{t('settings.account.delete', {})}</span>
            <span className={styles.v} aria-hidden>
              ›
            </span>
          </Pressable>
        </li>
      </ul>
    </section>
  );
}
