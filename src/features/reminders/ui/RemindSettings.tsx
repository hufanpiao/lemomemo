// 设置 › 提醒与通知 二级页正文（B2 FA-4；线框 s13 R_PUSH；数据字典第 9 节 remind.*；TC-B2-71、78、R-282 ③、第 105 条）
// 顶栏和返回由设置页画（照 calendar 的 CalendarSettings），这里只画正文：
// • 顶部提示（有才出）：推送被另一条设备记录占着 →“移除它”；推送需要重新打开 → 点一下；这个浏览器的推送服务暂不支持
// • 通知：已打开 / 没开（去系统设置；和首页“通知没开，提醒不会响”同一个说法，设计复审 M2）/ “打开通知”按钮（在点按里请求权限，FA-1 留给这里）；exe 写“电脑版用 Windows 通知”
// • 提醒里写什么 ›：一行写当前选的，点进去再选（R-347 照线框 sR7；选项页在 RemindShowTitle.tsx）——直接写标题和名字（默认，R-46）/ 锁屏只显示“有 1 项日程”（remind.show_title = false，R-188）
// • 免打扰 ›：一行写“23:00 – 08:00”（没开写“没开”），点进去开关、改时段（R-347 照线框 sR7；那一页在 RemindDnd.tsx）
// • 未来 7 天的提醒 ›（点了由设置页打开 RemindUpcoming，props.onOpenUpcoming）
// • “通知”单独一张卡，通知被关掉时说明紧跟在它下面；提醒里写什么、免打扰、测试提醒三行在下面另一张卡里（设计复审第二轮 N8；原来四行一张卡，说明隔了三行）
// • 测试提醒能不能收到：整行是行按钮，右边“发一条试试 ›”（照线框 R_PUSH，设计复审 M3）——网页版调 push-test，exe 弹本机测试通知（R-330）；结果写在下面
// • B2-UI-b W1（R-352）：卡、行都换成 kit 设置组件（SettingsCard / SettingsEntryRow / SettingsActionRow），行的顺序、分卡、文案不变；
//   原来手写的 .grp/.row/.rowBtn 和按下变淡规则删了（RemindSettings.module.css）
// 线框这一页的其余几行（日程默认提前、待办默认提醒、也装了电脑版时）不在 FA-4 范围，见交付说明；“纪念日提醒”一行 B5 接上（anniv 的 AnnivDefaults）
import { Suspense } from 'react';
import { AnnivDefaults } from '../../anniv/index.ts';
import { FormButton } from '../../../kit/components/Form.tsx';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { annivOn } from '../../../kit/hooks/anniv-on.ts';
import { SettingsActionRow, SettingsCard, SettingsEntryRow } from '../../../kit/components/Settings/Settings.tsx';
import { useMinuteNow } from '../../../kit/hooks/useMinuteNow.ts';
import { upcoming } from '../hooks/remind-view.ts';
import { useReminderList } from '../hooks/useReminders.ts';
import { useRemindSettings, type TestResult } from '../hooks/useRemindSettings.ts';
import { useRemindT, type RemindT } from '../hooks/useRemindT.ts';
import { NoticeCard } from './RemindNotice.tsx';
import styles from './RemindSettings.module.css';

function testMsg(t: RemindT, r: TestResult | 'sending'): string {
  switch (r) {
    case 'sending':
      return t('remind.set.test.sending', {});
    case 'sent':
      return t('remind.set.test.sent', {});
    case 'no_device':
      return t('remind.set.test.noDevice', {});
    case 'resubscribe':
      return t('remind.set.test.resubscribe', {});
    case 'rate_limited':
      return t('remind.set.test.rate', {});
    case 'offline':
      return t('remind.set.test.offline', {});
    case 'failed':
      return t('remind.set.test.failed', {});
    case 'local_shown':
      return t('remind.set.test.localShown', {});
    case 'local_denied':
      return t('remind.set.test.localDenied', {});
    case 'local_failed':
      return t('remind.set.test.localFailed', {});
  }
}

/** “未来 7 天的提醒  N 条 ›”放在最上面，下面一句说明（线框 sR7，设计 M5） */
function UpcomingEntry({ onOpen }: { onOpen?: (() => void) | undefined }) {
  const t = useRemindT();
  const now = useMinuteNow();
  const { list, tz } = useReminderList(now);
  const n = upcoming(list, now, tz).reduce((k, d) => k + d.items.length, 0);
  return (
    <SettingsCard title={t('remind.set.upcoming', {})} note={t('remind.set.upcoming.note', {})}>
      <SettingsEntryRow
        label={t('remind.set.upcoming', {})}
        value={t('remind.up.count', { n })}
        valueTestId="remind-upcoming-count"
        onOpen={() => onOpen?.()}
        testId="remind-open-upcoming"
      />
    </SettingsCard>
  );
}

/** 二级页正文；props: { onOpenUpcoming?、onOpenShowTitle?、onOpenDnd?（三个点进去的页，地址由设置页定） } */
export default function RemindSettings({
  onOpenUpcoming,
  onOpenShowTitle,
  onOpenDnd,
}: {
  onOpenUpcoming?: () => void;
  onOpenShowTitle?: () => void;
  onOpenDnd?: () => void;
}) {
  const t = useRemindT();
  const s = useRemindSettings();
  const denied = s.perm === 'denied';
  return (
    <div data-testid="settings-reminders">
      <NoticeCard s={s} />
      <UpcomingEntry onOpen={onOpenUpcoming} />

      {/* “通知”单独一张卡，通知被关掉的说明紧跟在它下面（设计复审第二轮 N8） */}
      <SettingsCard title={t('remind.set.notify', {})} note={denied ? t('remind.set.notify.denied', {}) : undefined} noteTestId="remind-denied-note">
        <SettingsActionRow
          label={t('remind.set.notify', {})}
          action={
            s.perm === 'default' ? (
              <FormButton type="button" variant="primary" onClick={() => void s.enable()} data-testid="remind-enable">
                {t('remind.set.notify.enable', {})}
              </FormButton>
            ) : undefined
          }
          value={t(
            s.perm === 'granted'
              ? 'remind.set.notify.on'
              : s.perm === 'tauri'
                ? 'remind.set.notify.tauri'
                : s.perm === 'unsupported'
                  ? 'remind.set.notify.unsupported'
                  : 'remind.set.notify.off',
            {},
          )}
          valueTestId="remind-perm"
        />
      </SettingsCard>

      {/* 下面三行另一张卡：没有说明夹在中间时两张卡之间留 12px，有说明时说明自己的下边距（16px）撑开（N8） */}
      <div className={denied ? undefined : styles.nextCard}>
        <SettingsCard title={t('remind.set.title', {})}>
          {/* 纪念日提醒的默认值（B5 S16，线框 R_PUSH 排在“提醒里写什么”前面）：纪念日功能的一行，开关关着不出；分包下不来那一行不画 */}
          {annivOn() ? (
            <QuietBoundary name="anniv-defaults">
              <Suspense fallback={null}>
                <AnnivDefaults part="remind-defaults" />
              </Suspense>
            </QuietBoundary>
          ) : null}
          <SettingsEntryRow
            label={t('remind.set.showTitle', {})}
            value={t(s.showTitle ? 'remind.set.showTitle.on' : 'remind.set.showTitle.off', {})}
            valueTestId="remind-show-title-value"
            onOpen={() => onOpenShowTitle?.()}
            testId="remind-open-show-title"
          />
          <SettingsEntryRow
            label={t('remind.set.dnd', {})}
            value={s.dnd.enabled ? t('remind.set.dnd.range', { start: s.dnd.start, end: s.dnd.end }) : t('remind.set.dnd.off', {})}
            valueTestId="remind-dnd-value"
            onOpen={() => onOpenDnd?.()}
            testId="remind-open-dnd"
          />
          <SettingsEntryRow
            label={t('remind.set.test', {})}
            value={t('remind.set.test.btn', {})}
            disabled={s.test === 'sending'}
            onOpen={() => void s.sendTest()}
            testId="remind-test"
          />
        </SettingsCard>
      </div>
      {s.test && (
        <p className={s.test === 'sent' || s.test === 'local_shown' ? styles.sn : styles.error} role="status" data-testid="remind-test-result" data-result={s.test}>
          {testMsg(t, s.test)}
        </p>
      )}
      {s.test === 'sent' && <p className={styles.sn}>{t('remind.set.test.help', {})}</p>}

      {s.error && (
        <p className={styles.error} role="alert">
          {t('remind.set.saveFailed', {})}
        </p>
      )}
    </div>
  );
}
