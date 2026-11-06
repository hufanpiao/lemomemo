// 设置 › 关于 二级页的正文（分组表里排最后；SETTINGS-merge-cards：首页卡 3 一个入口行，点进来是这一页）：
// 卡片里一行“版本 4.0.0”（设计评审 M-1，方案第 2 节和线框“关于 4.0.0 ›”）；农历数据的出处放在卡片下面（R-306：农历、节气数据要注明来自香港天文台；评审 S2）。
// “手机时间不准”（K8-clock）是要马上看到的提醒，不跟着进二级页：设置首页在卡 3 下面直接放（SettingsHome）
import { SettingsCard, SettingsInfoRow } from '../../../kit/components/Settings/Settings.tsx';
import { buildInfo } from '../../../platform/env.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import styles from './SettingsPage.module.css';

export function AboutSection() {
  const t = useSettingsT();
  return (
    <div data-section="about">
      <SettingsCard title={t('settings.about.title', {})} testId="settings-about-card">
        <SettingsInfoRow label={t('settings.about.version', {})} value={buildInfo.version} testId="settings-about-version" valueTestId="settings-about-version-value" />
      </SettingsCard>
      <p className={styles.sn} data-testid="settings-lunar-credit">
        {t('settings.about.lunarCredit', {})}
      </p>
    </div>
  );
}
