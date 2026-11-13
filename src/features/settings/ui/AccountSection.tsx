// 设置 › 账号 二级页的正文（R-256 ①；SETTINGS-merge-cards 负责人 11-05 定 A 甲）：首页卡 1 只有一个入口行，点进来是这些——
// 当前登录邮箱（R-275，只显示；读不到不显示）、已登录设备、退出其他所有设备（DevicesSection）、注销入口。
// 标题由二级页顶栏的 h1 给，这里不再有组标题；“最近的导出”挪进了数据二级页（评审补充：不两边都显示）；“退出登录”仍在首页最底下
import type { AccountErr } from '../hooks/useAccountActions.ts';
import { onlineNow } from '../../../kit/hooks/useOnline.ts';
import type { useDevices } from '../hooks/useDevices.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import { SettingsEntryRow, SettingsList } from '../../../kit/components/Settings/Settings.tsx';
import { DevicesSection } from './DevicesSection.tsx';
import styles from './SettingsPage.module.css';
import { MailLabel } from './MailLabel.tsx';

type T = ReturnType<typeof useSettingsT>;

/**
 * 导出、注销失败时的那一句（会话没了、停用、冷静期另走离开本机，不显示）。
 * 穷尽 switch、不写 default（R272-sugg ④，架构 0.29 续第 119 条②）：try_later 单独一支“服务器忙，稍后再试”；加了新码不补分支就编译不过
 */
export function accountErrText(e: AccountErr, t: T, online: boolean = onlineNow()): string {
  switch (e) {
    case 'rate_limited':
      return t('settings.account.rateLimited', {});
    // 临时故障：只提示，不清本机、不回登录页（TC-B1-90）
    case 'try_later':
      return t('settings.err.tryLater', {});
    // 只有 navigator.onLine 为 false 才说“没有网络”，其余说“暂时连不上服务器”（必改第 7 条）
    case 'offline':
      return t(online ? 'settings.err.unreachable' : 'settings.err.offline', {});
    case 'confirm_required':
      return t('settings.delete.confirmRequired', { word: t('settings.delete.word', {}) });
    case 'admin_cannot_delete':
      return t('settings.delete.admin', {});
    case 'account_disabled':
      return t('settings.err.accountDisabled', {});
    // 导出分片（0.47 续 ④ 第 4 点）
    case 'export_expired':
      return t('settings.export.expired', {});
    case 'export_too_large':
      return t('settings.export.tooLarge', {});
    case 'revoked':
    case 'signed_out':
    case 'pending_deletion':
    case 'bad_response':
    case 'vault_locked':
    case 'unknown':
      return t('settings.err.unknown', {});
  }
}

export function AccountSection({
  devices, email, onExitHere, onDelete,
}: {
  devices: ReturnType<typeof useDevices>;
  /** 当前登录邮箱（R-275，经 useSettingsPage 读本机会话）；null 时这一行不显示 */
  email: string | null;
  onExitHere(): void;
  onDelete(): void;
}) {
  const t = useSettingsT();
  return (
    <div data-section="account">
      {email ? (
        <p className={styles.email} data-testid="settings-account-email">
          <span className={styles.srOnly}>{t('settings.account.email', {})}</span>
          <MailLabel mail={email} />
        </p>
      ) : null}
      <DevicesSection devices={devices} onExitHere={onExitHere} />
      {/* 注销入口（B2-UI-b W3）：kit 整行按钮的危险色，› 和别的入口行同一个 */}
      <div className={styles.gap}>
        <SettingsList>
          <SettingsEntryRow label={t('settings.account.delete', {})} danger disabled={devices.busy !== null} onOpen={onDelete} testId="settings-delete-entry" />
        </SettingsList>
      </div>
    </div>
  );
}
