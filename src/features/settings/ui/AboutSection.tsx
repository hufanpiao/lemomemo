// 设置 › 关于（分组表里排最后）：先只放农历出处（R-306：农历、节气数据要注明来自香港天文台）；版本号等以后再加
import { useSettingsT } from '../hooks/useSettingsT.ts';
import styles from './SettingsPage.module.css';

export function AboutSection() {
  const t = useSettingsT();
  return (
    <section aria-labelledby="settings-about-title" data-section="about">
      <h2 id="settings-about-title" className={styles.gt}>
        {t('settings.about.title', {})}
      </h2>
      <p className={styles.sn} data-testid="settings-lunar-credit">
        {t('settings.about.lunarCredit', {})}
      </p>
    </section>
  );
}
