// 设置首页“提醒与通知”一行（B2 FA-4；定稿线框 s13：“提醒与通知 … 通知已打开 ›”）：只显示摘要，点了进二级页（设置页决定地址，props.onOpen）
// • 摘要：通知已打开 / 通知没开；exe 写“Windows 通知”
// • 挂在设置页的 reminders 分组（SETTINGS_SECTION_ORDER 已有 'reminders'）
import { Pressable } from '../../../motion/components.ts';
import { usePermState } from '../hooks/useRemindSettings.ts';
import { useRemindT } from '../hooks/useRemindT.ts';
import styles from './RemindSettings.module.css';

export default function RemindSettingsEntry({ onOpen }: { onOpen(): void }) {
  const t = useRemindT();
  const [perm] = usePermState();
  const summary = perm === 'tauri' ? 'remind.set.summary.desk' : perm === 'granted' ? 'remind.set.summary.on' : 'remind.set.summary.off';
  return (
    <section aria-labelledby="settings-remind-entry-title">
      <h2 id="settings-remind-entry-title" className={styles.srOnly}>
        {t('remind.set.title', {})}
      </h2>
      <ul className={styles.grp}>
        <li className={styles.row}>
          <Pressable className={styles.rowBtn} onClick={onOpen} data-testid="settings-remind-entry">
            <span className={styles.tx}>{t('remind.set.title', {})}</span>
            <span className={styles.v} data-testid="settings-remind-summary">
              {t(summary, {})}
            </span>
            <span className={styles.chev} aria-hidden>
              ›
            </span>
          </Pressable>
        </li>
      </ul>
    </section>
  );
}
