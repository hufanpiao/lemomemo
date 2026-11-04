// 设置 › 关于（分组表里排最后）：农历出处（R-306：农历、节气数据要注明来自香港天文台）；版本号等以后再加
// “手机时间不准”（K8-clock，REMIND-wiring）：由 reminders 功能懒加载提供，偏差正常时不画；放在出处上面
import { Suspense } from 'react';
import { ClockWrongNote } from '../../reminders/index.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import styles from './SettingsPage.module.css';

export function AboutSection() {
  const t = useSettingsT();
  return (
    <section aria-labelledby="settings-about-title" data-section="about">
      <h2 id="settings-about-title" className={styles.gt}>
        {t('settings.about.title', {})}
      </h2>
      <Suspense fallback={null}>
        <ClockWrongNote />
      </Suspense>
      <p className={styles.sn} data-testid="settings-lunar-credit">
        {t('settings.about.lunarCredit', {})}
      </p>
    </section>
  );
}
