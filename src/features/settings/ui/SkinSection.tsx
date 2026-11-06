// 设置 › 倾斜高光（SETTINGS_SECTION_ORDER 的 'skin'，卡 2 里排在界面语言之后；TILT-b2 做法 ②）
// 合卡以后（SETTINGS-merge-cards M2）：两行的开关行，说明和拒绝报错都写在这一行里、不挂在卡片下面；
// “皮肤”这一行在皮肤选择做出来之前不加（没有可选的值，单独一行会变成点不动的空行）
import { SettingsSwitchRow } from '../../../kit/components/Settings/Settings.tsx';
import { useTiltPref, type TiltDeps } from '../hooks/useTiltPref.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';

export function SkinSection({ deps }: { deps?: TiltDeps | undefined }) {
  const t = useSettingsT();
  const tilt = useTiltPref(deps);
  return (
    <SettingsSwitchRow
      label={t('settings.skin.tilt', {})}
      checked={tilt.on}
      onChange={(v) => void tilt.set(v)}
      note={t('settings.skin.tiltNote', {})}
      error={tilt.note === 'denied' ? t('settings.skin.tiltDenied', {}) : null}
      testId="settings-tilt"
      rowId="skin"
    />
  );
}
