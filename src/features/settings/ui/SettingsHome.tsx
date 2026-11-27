// 设置首页：卡和顺序见 data/sections.ts 的 SETTINGS_CARDS，每一行是 kit 的设置行；
// 账号、日历、提醒与通知、语音与 AI、数据、在 Claude 聊天里记事、电脑、关于都是“一行入口 + 二级页”，语言在首页直接改
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { DeskCard } from '../../../kit/components/Desk.tsx';
import { CalendarSettingsValue } from '../../calendar/index.ts';
import { AiProviderSettings } from '../../ai-provider/index.ts';
import { PlusSettings } from '../../plus/index.ts';
import { TodoSettings } from '../../todos/index.ts';
import { ClockWrongNote, RemindSettingsValue } from '../../reminders/index.ts';
import { WeatherSettingValue } from '../../weather/index.ts';
import { MeAvatar } from '../../../kit/components/MeAvatar.tsx';
import refine from '../../../kit/components/Refine.module.css';
import { buildInfo } from '../../../platform/env.ts';
import { Later } from '../../../kit/components/QuietBoundary.tsx';
import { SettingsCard, SettingsEntryRow, SettingsList, SettingsSwitchRow } from '../../../kit/components/Settings/Settings.tsx';
import { cardsOf, deskRowsOf, type SettingsCardId, type SettingsDeskGroupId, type SettingsSectionId } from '../hooks/useSettingsPage.ts';
import type { ExportState } from '../hooks/useExport.ts';
import { hotkeyLabel, type QuickAddHotkey } from '../hooks/useQuickAddHotkey.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import { useNotesViewSetting } from '../hooks/useNotesViewSetting.ts';
import { useFxSetting } from '../hooks/useFxSetting.ts';
import type { DevicesState } from '../hooks/useDevices.ts';
import { deviceName } from './DevicesSection.tsx';
import { LanguageSection } from './LanguageSection.tsx';
import { MailLabel } from './MailLabel.tsx';
import { FontHomeRow } from './FontSection.tsx';
import { SkinHomeRows } from './SkinSection.tsx';
import { TrashRows } from './TrashRows.tsx';
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
  /** 网页版宽屏右边详情：只画左目录选中的这一组（标题行“组名 | N 项”+ 这一组的行）；不给就是手机版的整页卡片 */
  group?: SettingsDeskGroupId | undefined;
};

/** 宽屏详情里数一下实际画出来的行（最近删除一组两行、AI 服务商只有管理员才有，懒加载的行到了再数） */
function useRowCount(ref: RefObject<HTMLElement | null>, key: string): number {
  const [n, setN] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const count = (): void => setN(el.querySelectorAll('ul > li').length);
    count();
    const mo = new MutationObserver(count);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [ref, key]);
  return n;
}

/** “声音和触感”一行：开关，读写在 hooks/useFxSetting.ts */
function FxRow() {
  const t = useSettingsT();
  const fx = useFxSetting();
  return (
    <SettingsSwitchRow
      rowId="fx"
      label={t('settings.fx.title', {})}
      checked={fx.on}
      onChange={(v) => void fx.set(v)}
      error={fx.error ? t('settings.fx.err', {}) : null}
      testId="settings-fx"
    />
  );
}

/** “邀请朋友”一行（只有管理员看得到，R-83）：行由本页画，画不画由 ai-provider 懒加载判断（同“AI 服务商”，mine 回 admin: true 才画），
 *  二级页正文由 invite 功能懒加载；没到之前、不是管理员都不画 */
function InviteRow({ onOpen }: { onOpen(): void }) {
  const t = useSettingsT();
  return (
    <Later name="invite-row">
      <AiProviderSettings part="adminOnly">
        <SettingsEntryRow
          rowId="invite"
          label={t('settings.invite.title', {})}
          value={t('settings.invite.value', {})}
          onOpen={onOpen}
          testId="settings-invite-entry"
          valueTestId="settings-invite-summary"
        />
      </AiProviderSettings>
    </Later>
  );
}

const CARD_TITLE ={ account: 'settings.account.title', main: 'settings.card.main', trash: 'settings.trash.title', more: 'settings.card.more' } as const;

export function SettingsHome({ email, devices, locale, exportState: ex, hotkey, onOpen, footer, group }: HomeProps) {
  const t = useSettingsT();
  const deskRef = useRef<HTMLDivElement>(null);
  const deskN = useRowCount(deskRef, group ?? '');
  /** 卡名（只给读屏；账号卡就叫“账号”）；“最近删除”一张看得见 */
  const cardTitle = (card: SettingsCardId): string => t(CARD_TITLE[card], {});
  /** 账号一行的值：读设备列表时是固定宽度的占位，读不出来写一句，读到了写“N 台设备：本机、其他…”（放在邮箱下面一行，太长时换行、不省略，见 stacked） */
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
  /** 数据一行的值：导出没跑完时只写“正在导出…”、不写 MB 数字；中断了写“导出中断了”；其余空着 */
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
      // 账号一行：邮箱和设备摘要上下两行，长邮箱、“设备列表读不出来”不截断
      stacked={id === 'account'}
      value={value}
      onOpen={() => onOpen(id)}
      testId={`settings-${testId}-entry`}
      valueTestId={`settings-${testId}-summary`}
    />
  );

  const rows: Partial<Record<SettingsSectionId, ReactNode>> = {
    // 账号一行前面是今天页那个头像圈（同一组件、同样尺寸）
    account: entry('account', email === null ? t('settings.account.title', {}) : <MailLabel mail={email} />, 'account', accountValue, <MeAvatar testId="settings-account-avatar" />),
    language: <LanguageSection locale={locale} />,
    // 皮肤（ADR-008）：一行“简洁 · 白天 / 夜间跟着手机 ›”点进 #/settings/skin（SkinSection.tsx 的 SkinHomeRows）
    skin: <SkinHomeRows onOpen={() => onOpen('skin')} />,
    mascot: entry('mascot', t('settings.mascot.title', {}), 'mascot'),
    // 字体（“字体 › 系统字体（默认）”）：点进 #/settings/font
    font: <FontHomeRow onOpen={() => onOpen('font')} />,
    // 随手记显示方式：一行写完“列表 · 只对本类设备生效 ›”（没设过时显示“列表”）；手机、电脑各自的说明在二级页
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
    // 声音和触感：操作音效和震动的总开关，默认开；存 settings 的 ui.fx（各设备同步）
    fx: <FxRow />,
    // 待办“完成 7 天后自动删除”：开关整行由 todos 功能懒加载（键和默认值在那边一处），没到之前这一行不画
    todos: <Later name="todo-settings"><TodoSettings /></Later>,
    // 日历、提醒与通知：行名和整行由本页画，值由各自的功能懒加载（行一开始就能点）；
    // 值没到之前空着，分包下载失败也只是空着（QuietBoundary 的 name 照约定写成字符串常量）
    calendar: (
      <SettingsEntryRow
        rowId="calendar"
        label={t('settings.cal.title', {})}
        value={
          <Later name="cal-value"><CalendarSettingsValue /></Later>
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
          <Later name="remind-value"><RemindSettingsValue /></Later>
        }
        onOpen={() => onOpen('remind')}
        testId="settings-remind-entry"
        valueTestId="settings-remind-summary"
      />
    ),
    // 语音与 AI、在 Claude 聊天里记事（同日历一行）：Claude 那行的值由 plus 功能懒加载（连着没有），没到之前空着
    voiceAi: (
      <SettingsEntryRow
        rowId="voiceAi"
        label={t('settings.ai.title', {})}
        // 行名下面不写说明和用量，用量进二级页看
        onOpen={() => onOpen('ai')}
        testId="settings-ai-entry"
      />
    ),
    // 我的 AI（人人都有）：同上一行，值由 ai-provider 功能懒加载（“柠檬记提供 · 12 / 50”），没到之前空着
    myAi: (
      <SettingsEntryRow
        rowId="myAi"
        label={t('settings.myAi.title', {})}
        value={
          <Later name="my-ai-value"><AiProviderSettings part="myAiValue" /></Later>
        }
        onOpen={() => onOpen('my-ai')}
        testId="settings-my-ai-entry"
        valueTestId="settings-my-ai-summary"
      />
    ),
    // 隐私记：进二级页，正文由 vault 功能懒加载
    vault: <SettingsEntryRow rowId="vault" label={t('settings.vault.title', {})} onOpen={() => onOpen('vault')} testId="settings-vault-entry" />,
    // 天气：今天页天气胶囊看哪儿；值（自动定位 / 城市名 / 不看天气）由 weather 功能懒加载，没到之前空着
    weather: entry('weather', t('settings.weather.title', {}), 'weather', <Later name="weather-value"><WeatherSettingValue /></Later>),
    // 最近删除：两行“待办”“随手记”带条数，点进只列这一类的最近删除页（TrashRows.tsx）
    trash: <TrashRows />,
    data: entry('data', t('settings.data.title', {}), 'data', dataValue),
    claude: (
      <SettingsEntryRow
        rowId="claude"
        label={t('settings.claude.title', {})}
        value={
          <Later name="claude-value"><PlusSettings part="claude" view="value" /></Later>
        }
        onOpen={() => onOpen('claude')}
        testId="settings-claude-entry"
        valueTestId="settings-claude-summary"
      />
    ),
    // AI 服务商（只有管理员看得到）：整行由 ai-provider 功能懒加载，ai-provider 函数 mine 回 admin: true 才画，值是对话和整理那项的服务商
    aiProvider: (
      <Later name="ai-provider-row"><AiProviderSettings part="adminRow" label={t('settings.aiProv.title', {})} onOpen={() => onOpen('ai-provider')} /></Later>
    ),
    // 邀请朋友（只有管理员看得到，R-83）：见 InviteRow
    invite: <InviteRow onOpen={() => onOpen('invite')} />,
    // 不在电脑版 exe 里读回 null，“电脑”这一行不出现；值是现在的热键
    ...(hotkey.status
      ? { desktop: entry('desktop', t('settings.desktop.title', {}), 'desktop', hotkeyLabel(hotkey.status.accelerator, t('settings.hotkey.space', {}))) }
      : {}),
    // 关于一行的值是版本号（“关于 4.0.0 ›”）
    about: entry('about', t('settings.about.title', {}), 'about', <span className={refine.num}>{buildInfo.version}</span>),   // 版本号等宽
  };

  if (group !== undefined) {
    // 右边详情卡（kit DeskCard）：标题行“组名 | N 项”就是这一组的标题（读屏只读这一次），下面的行不再另带一个隐藏卡名
    return (
      <DeskCard title={t(`settings.dk.g.${group}`, {})} end={t('settings.dk.n', { n: deskN })} className={styles.dkDetail} data-testid="settings-dk-detail" part>
        <div ref={deskRef} className={styles.dkGroup} data-testid={`settings-dk-group-${group}`}>
          <SettingsList testId={`settings-card-${group}`}>
            {deskRowsOf(rows, group).map(([id, node]) => (
              <Fragment key={id}>{node}</Fragment>
            ))}
          </SettingsList>
          {group === 'about' ? <Later name="clock-note"><ClockWrongNote /></Later> : null}
          {group === 'account' ? footer : null}
        </div>
      </DeskCard>
    );
  }

  return (
    <>
      <div className={styles.groups}>
        {cardsOf(rows).map(([card, list]) => (
          <SettingsCard key={card} title={cardTitle(card)} showTitle={card === 'trash'} testId={`settings-card-${card}`}>
            {list.map(([id, node]) => (
              <Fragment key={id}>{node}</Fragment>
            ))}
          </SettingsCard>
        ))}
      </div>
      {/* “手机时间不准”要马上看到，不跟着“关于”进二级页；偏差正常时不画 */}
      <Later name="clock-note"><ClockWrongNote /></Later>
      {footer}
    </>
  );
}

