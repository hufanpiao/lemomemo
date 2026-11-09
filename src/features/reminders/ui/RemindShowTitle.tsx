// 设置 › 提醒与通知 › 提醒里写什么（R-347：照线框 sR7 点进去再选；B2 FA-4；R-46、R-188）
// • 两个选项各一行、整行可点（label），选中的右边“✓”：直接写标题和名字（默认）/ 锁屏只显示“有 1 项日程”（remind.show_title = false）
// • 下面一句说明锁屏只显示时推送写什么。顶栏、返回由设置页画，这里只画正文；组标题只给读屏（顶栏已经写了）
// • B2-UI-b W1（R-352）：换成 kit 的 SettingsChoiceCard（每项一行、选中的右边“✓”，组名只给读屏）
import { SettingsChoiceCard } from '../../../kit/components/Settings/Settings.tsx';
import { useRemindSettings } from '../hooks/useRemindSettings.ts';
import { useRemindT } from '../hooks/useRemindT.ts';
import styles from './RemindSettings.module.css';

export default function RemindShowTitle() {
  const t = useRemindT();
  const s = useRemindSettings();
  return (
    <div data-testid="settings-remind-show-title">
      <SettingsChoiceCard
        title={t('remind.set.showTitle', {})}
        name="remind-show-title"
        options={[
          { value: 'on', label: t('remind.set.showTitle.on', {}), testId: 'remind-show-title-on' },
          { value: 'off', label: t('remind.set.showTitle.off', {}), testId: 'remind-show-title-off' },
        ]}
        value={s.showTitle ? 'on' : 'off'}
        onPick={(v) => {
          // 点亮着的那项不重复写
          if ((v === 'on') !== s.showTitle) void s.setShowTitle(v === 'on');
        }}
        note={t('remind.set.showTitle.note', {})}
      />
      {s.error && (
        <p className={styles.error} role="alert">
          {t('remind.set.saveFailed', {})}
        </p>
      )}
    </div>
  );
}
