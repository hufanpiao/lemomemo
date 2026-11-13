// 设置首页：三张卡（R-325，SETTINGS-merge-cards 方案定稿；卡和顺序见 data/sections.ts 的 SETTINGS_CARDS），每一行是 kit 的设置行；
// 账号、日历、提醒与通知、语音与 AI、数据、在 Claude 聊天里记事、电脑、关于都是“一行入口 + 二级页”，语言在首页直接改（倾斜高光已删除，R-373）。从 SettingsPage 拆出
import { Fragment, Suspense, type ReactNode } from 'react';
import { CalendarSettingsValue } from '../../calendar/index.ts';
import { PlusSettings } from '../../plus/index.ts';
import { ClockWrongNote, RemindSettingsValue } from '../../reminders/index.ts';
import { MeAvatar } from '../../../kit/components/MeAvatar.tsx';
import { buildInfo } from '../../../platform/env.ts';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { SettingsCard, SettingsEntryRow } from '../../../kit/components/Settings/Settings.tsx';
import { cardsOf, type SettingsCardId, type SettingsSectionId } from '../hooks/useSettingsPage.ts';
import type { ExportState } from '../hooks/useExport.ts';
import { hotkeyLabel, type QuickAddHotkey } from '../hooks/useQuickAddHotkey.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import { useNotesViewSetting } from '../hooks/useNotesViewSetting.ts';
import type { DevicesState } from '../hooks/useDevices.ts';
import { deviceName } from './DevicesSection.tsx';
import { LanguageSection } from './LanguageSection.tsx';
import { MailLabel } from './MailLabel.tsx';
import { FontHomeRow } from './FontSection.tsx';
import { SkinHomeRows } from './SkinSection.tsx';
import type { SubName } from './SettingsSub.tsx';
import styles from './SettingsPage.module.css';

type HomeProps = {
  email: string | null;
  devices: DevicesState;
  locale: Parameters<typeof LanguageSection>[0]['locale'];
  exportState: ExportState;
  hotkey: QuickAddHotkey;
  onOpen(name: SubName): void;
  /** 最底下的“退出登录” */
  footer: ReactNode;
};

export function SettingsHome({ email, devices, locale, exportState: ex, hotkey, onOpen, footer }: HomeProps) {
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
  const notesView = useNotesViewSetting();
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
    // 皮肤（ADR-008；定稿线框第 997 行、皮肤视觉稿第 1368 行）：一行“简洁 · 白天 / 夜间跟着手机 ›”点进 #/settings/skin；
    // 下面紧跟两个开关（R-84 减少透明效果、R-93 减少动态效果），说明按手机 / 电脑分（视觉稿电脑版第 1498 行）
    skin: <SkinHomeRows onOpen={() => onOpen('skin')} />,
    // 字体（架构 5.9c；定稿线框 s13“字体 › 系统字体（默认）”）：点进 #/settings/font
    font: <FontHomeRow onOpen={() => onOpen('font')} />,
    // 随手记显示方式（B4 S1，R-78；定稿线框第 997 行、皮肤视觉稿第 1368 行）：一行写完“瀑布流 · 只对本类设备生效 ›”（稿子第 997 行）；手机、电脑各自的说明在二级页
    notesView: (
      <SettingsEntryRow
        rowId="notesView"
        label={t('settings.notesView.title', {})}
        value={t('settings.notesView.value', { v: t(notesView.view === 'list' ? 'settings.notesView.list' : 'settings.notesView.masonry', {}) })}
        onOpen={() => onOpen('notes-view')}
        testId="settings-notes-view-entry"
        valueTestId="settings-notes-view-summary"
      />
    ),
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
    // 语音与 AI、在 Claude 聊天里记事（B3 FA-4，同日历一行）：值由 plus 功能懒加载（今天用量、连着没有），没到之前空着
    voiceAi: (
      <SettingsEntryRow
        rowId="voiceAi"
        label={t('settings.ai.title', {})}
        value={
          <QuietBoundary name="ai-value">
            <Suspense fallback={null}>
              <PlusSettings part="voiceAi" view="value" />
            </Suspense>
          </QuietBoundary>
        }
        // 值“AI 整理已打开 · 今天 AI 用了 n 次 / 共 50 次”一行放不下：照线框 s13 放到行名下面，不省略（R-369）
        stacked
        onOpen={() => onOpen('ai')}
        testId="settings-ai-entry"
        valueTestId="settings-ai-summary"
      />
    ),
    // 隐私记（B5 S11，线框 s13 SETDETAIL）：进二级页，正文由 vault 功能懒加载
    vault: <SettingsEntryRow rowId="vault" label={t('settings.vault.title', {})} onOpen={() => onOpen('vault')} testId="settings-vault-entry" />,
    data: entry('data', t('settings.data.title', {}), 'data', dataValue),
    claude: (
      <SettingsEntryRow
        rowId="claude"
        label={t('settings.claude.title', {})}
        value={
          <QuietBoundary name="claude-value">
            <Suspense fallback={null}>
              <PlusSettings part="claude" view="value" />
            </Suspense>
          </QuietBoundary>
        }
        onOpen={() => onOpen('claude')}
        testId="settings-claude-entry"
        valueTestId="settings-claude-summary"
      />
    ),
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

