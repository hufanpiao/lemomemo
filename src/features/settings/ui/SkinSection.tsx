// 设置 › 皮肤（SETTINGS_SECTION_ORDER 的 'skin'，排在界面语言之后）：目前只有“倾斜高光”一行（TILT-b2 做法 ②）
// 开关写法和提醒页免打扰（RemindDnd）一样：<label> 包文字和 role="switch" 的复选框；样式 .switchRow、.toggle 在 SettingsPage.module.css
import { useTiltPref, type TiltDeps } from '../hooks/useTiltPref.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import styles from './SettingsPage.module.css';

export function SkinSection({ deps }: { deps?: TiltDeps | undefined }) {
  const t = useSettingsT();
  const tilt = useTiltPref(deps);
  return (
    <section aria-labelledby="settings-skin-title">
      <h2 id="settings-skin-title" className={styles.gt}>
        {t('settings.skin.title', {})}
      </h2>
      <ul className={styles.grp}>
        <li className={styles.row}>
          <label className={styles.switchRow}>
            <span className={styles.tx}>{t('settings.skin.tilt', {})}</span>
            <input
              type="checkbox"
              role="switch"
              className={styles.toggle}
              checked={tilt.on}
              aria-describedby="settings-skin-tilt-note"
              onChange={(e) => void tilt.set(e.currentTarget.checked)}
              data-testid="settings-tilt"
            />
          </label>
        </li>
      </ul>
      <p id="settings-skin-tilt-note" className={styles.sn}>
        {t('settings.skin.tiltNote', {})}
      </p>
      {tilt.note === 'denied' ? (
        <p className={styles.error} role="status">
          {t('settings.skin.tiltDenied', {})}
        </p>
      ) : null}
    </section>
  );
}
