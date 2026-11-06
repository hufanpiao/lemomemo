// 设置首页：三张卡（R-325，SETTINGS-merge-cards 方案定稿；卡和顺序见 data/sections.ts 的 SETTINGS_CARDS），每一行是 kit 的设置行；
// 账号、日历、提醒与通知、数据、电脑、关于都是“一行入口 + 二级页”，语言、倾斜高光在首页直接改。从 SettingsPage 拆出
import { Fragment, Suspense, type ReactNode } from 'react';
import { CalendarSettingsValue } from '../../calendar/index.ts';
import { ClockWrongNote, RemindSettingsValue } from '../../reminders/index.ts';
import { MeAvatar } from '../../../kit/components/MeAvatar.tsx';
import { buildInfo } from '../../../platform/env.ts';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { SettingsCard, SettingsEntryRow } from '../../../kit/components/Settings/Settings.tsx';
import { cardsOf, type SettingsCardId, type SettingsDeps, type SettingsSectionId } from '../hooks/useSettingsPage.ts';
import type { ExportState } from '../hooks/useExport.ts';
import { hotkeyLabel, type QuickAddHotkey } from '../hooks/useQuickAddHotkey.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import type { DevicesState } from '../hooks/useDevices.ts';
import { deviceName } from './DevicesSection.tsx';
import { LanguageSection } from './LanguageSection.tsx';
import { MailLabel } from './MailLabel.tsx';
import { SkinSection } from './SkinSection.tsx';
import type { SubName } from './SettingsSub.tsx';
import styles from './SettingsPage.module.css';

type HomeProps = {
  email: string | null;
  devices: DevicesState;
  locale: Parameters<typeof LanguageSection>[0]['locale'];
  exportState: ExportState;
  hotkey: QuickAddHotkey;
  tilt: SettingsDeps['tilt'];
  onOpen(name: SubName): void;
  /** 最底下的“退出登录” */
  footer: ReactNode;
};

export function SettingsHome({ email, devices, locale, exportState: ex, hotkey, tilt, onOpen, footer }: HomeProps) {
  const t = useSettingsT();
  /** 卡片看不见的标题（M3）：卡 1 就叫“账号” */
  const cardTitle = (card: SettingsCardId): string =>
    card === 'account' ? t('settings.account.title', {}) : card === 'main' ? t('settings.card.main', {}) : t('settings.card.more', {});
  /** 账号一行的值（评审 A）：读设备列表时是固定宽度的占位，读不出来写一句，读到了写“N 台设备：本机、其他…”（放在邮箱下面一行，太长时换行、不省略，见 stacked） */
  const accountValue =
    devices.kind === 'loading' ? (
      <span className={styles.ph} aria-hidden="true" data-testid="settings-account-loading" />
    ) : devices.kind === 'error' ? (
      t('settings.account.devicesFailed', {})
    ) : devices.list.length === 0 ? (
      t('settings.account.devicesN', { n: 0 })
    ) : (
      t('settings.account.devicesList', {
        n: devices.list.length,
        names: devices.list.map((d) => deviceName(d, t)).join(t('settings.account.nameSep', {})),
      })
    );
  /** 数据一行的值：导出没跑完时只写“正在导出…”、不写 MB 数字（负责人 11-05 ②）；中断了写“导出中断了”；其余空着 */
  const dataValue =
    ex.kind === 'busy'
      ? t('settings.data.busyShort', {})
      : ex.kind === 'paused'
        ? t('settings.data.pausedShort', {})
        : undefined;
  const entry = (id: SubName & SettingsSectionId, label: ReactNode, testId: string, value?: ReactNode, lead?: ReactNode): ReactNode => (
    <SettingsEntryRow
      rowId={id}
      label={label}
      lead={lead}
      // 账号一行：邮箱和设备摘要上下两行，长邮箱、“设备列表读不出来”不截断（韩文审校 A-4）
      stacked={id === 'account'}
      value={value}
      onOpen={() => onOpen(id)}
      testId={`settings-${testId}-entry`}
      valueTestId={`settings-${testId}-summary`}
    />
  );

  const rows: Partial<Record<SettingsSectionId, ReactNode>> = {
    // 账号一行前面是今天页那个头像圈（负责人 11-05 ①：同一组件、同样尺寸）
    account: entry('account', email === null ? t('settings.account.title', {}) : <MailLabel mail={email} />, 'account', accountValue, <MeAvatar testId="settings-account-avatar" />),
    language: <LanguageSection locale={locale} />,
    // 设置 › 倾斜高光（TILT-b2）：开关存本机、默认关；“皮肤”一行等皮肤选择做出来再加（M2）
    skin: <SkinSection deps={tilt} />,
    // 日历（R-320）、提醒与通知（REMIND-wiring）：行名和整行由本页画，值由各自的功能懒加载（M4：行一开始就能点）；
    // 值没到之前空着，分包下载失败也只是空着（QuietBoundary 的 name 照约定写成字符串常量）
    calendar: (
      <SettingsEntryRow
        rowId="calendar"
        label={t('settings.cal.title', {})}
        value={
          <QuietBoundary name="cal-value">
            <Suspense fallback={null}>
              <CalendarSettingsValue />
            </Suspense>
          </QuietBoundary>
        }
        onOpen={() => onOpen('calendar')}
        testId="settings-cal-entry"
        valueTestId="settings-cal-summary"
      />
    ),
    reminders: (
      <SettingsEntryRow
        rowId="reminders"
        label={t('settings.remind.title', {})}
        value={
          <QuietBoundary name="remind-value">
            <Suspense fallback={null}>
              <RemindSettingsValue />
            </Suspense>
          </QuietBoundary>
        }
        onOpen={() => onOpen('remind')}
        testId="settings-remind-entry"
        valueTestId="settings-remind-summary"
      />
    ),
    data: entry('data', t('settings.data.title', {}), 'data', dataValue),
    // R-297：不在电脑版 exe 里读回 null，“电脑”这一行不出现；值是现在的热键
    ...(hotkey.status
      ? { desktop: entry('desktop', t('settings.desktop.title', {}), 'desktop', hotkeyLabel(hotkey.status.accelerator, t('settings.hotkey.space', {}))) }
      : {}),
    // 关于一行的值是版本号（设计评审 M-1，线框“关于 4.0.0 ›”）
    about: entry('about', t('settings.about.title', {}), 'about', buildInfo.version),
  };

  return (
    <>
      <div className={styles.groups}>
        {cardsOf(rows).map(([card, list]) => (
          <SettingsCard key={card} title={cardTitle(card)} testId={`settings-card-${card}`}>
            {list.map(([id, node]) => (
              <Fragment key={id}>{node}</Fragment>
            ))}
          </SettingsCard>
        ))}
      </div>
      {/* “手机时间不准”（K8-clock）要马上看到，不跟着“关于”进二级页；偏差正常时不画 */}
      <QuietBoundary name="clock-note">
        <Suspense fallback={null}>
          <ClockWrongNote />
        </Suspense>
      </QuietBoundary>
      {footer}
    </>
  );
}

