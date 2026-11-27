// 设置 › 提醒与通知 › 免打扰（点进去再改；remind.dnd）
// • 一行开关：整行是开关的 label，点行里哪儿都能切换；打开后一行“从 / 到”两个时刻
// • 开始和结束选成同一时刻：提示、不写；下面一句说明落在免打扰里的提醒怎么办。顶栏、返回由设置页画，这里只画正文
// • 卡、开关行、“从 / 到”时刻行用 kit 设置组件（SettingsCard / SettingsSwitchRow / SettingsTimesRow）
import { SettingsCard, settingsCardNoteClass, SettingsSwitchRow } from '../../../kit/components/Settings/Settings.tsx';
import { SettingsTimesRow } from '../../../kit/components/Settings/SettingsTimesRow.tsx';
import { isHm } from '../hooks/remind-view.ts';
import { useRemindSettings } from '../hooks/useRemindSettings.ts';
import { useRemindT } from '../hooks/useRemindT.ts';
import styles from './RemindSettings.module.css';

type S = ReturnType<typeof useRemindSettings>;

/**
 * 免打扰：开关 + 从 / 到；卡名只给读屏（行里已经写了“免打扰”）。
 * “从 / 到”是 kit 选择器：选成和另一头一样时选择器里红字提示、“确定”变灰，存不进去
 */
function DndSection({ s }: { s: S }) {
  const t = useRemindT();
  const same = t('remind.set.dnd.same', {});
  const dnd = t('remind.set.dnd', {});
  return (
    <>
      <SettingsCard title={t('remind.set.dnd', {})}>
        <SettingsSwitchRow
          label={t('remind.set.dnd', {})}
          checked={s.dnd.enabled}
          onChange={(on) => void s.setDnd({ ...s.dnd, enabled: on })}
          testId="remind-dnd-on"
        />
        {s.dnd.enabled && (
          <SettingsTimesRow
            fields={[
              {
                label: t('remind.set.dnd.from', {}),
                title: `${dnd} ${t('remind.set.dnd.from', {})}`,
                value: s.dnd.start,
                notSame: { value: s.dnd.end, text: same },
                onChange: (v) => {
                  if (isHm(v)) void s.setDnd({ ...s.dnd, start: v });
                },
                testId: 'remind-dnd-start',
              },
              {
                label: t('remind.set.dnd.to', {}),
                title: `${dnd} ${t('remind.set.dnd.to', {})}`,
                value: s.dnd.end,
                notSame: { value: s.dnd.start, text: same },
                onChange: (v) => {
                  if (isHm(v)) void s.setDnd({ ...s.dnd, end: v });
                },
                testId: 'remind-dnd-end',
              },
            ]}
          />
        )}
      </SettingsCard>
      <p className={settingsCardNoteClass}>{t('remind.set.dnd.note', {})}</p>
    </>
  );
}

export default function RemindDnd() {
  const t = useRemindT();
  const s = useRemindSettings();
  return (
    <div data-testid="settings-remind-dnd">
      <DndSection s={s} />
      {s.error && (
        <p className={styles.error} role="alert">
          {t('remind.set.saveFailed', {})}
        </p>
      )}
    </div>
  );
}
