// 设置 › 皮肤 二级页正文（ADR-008；R-20、R-148 两套皮肤“简洁 / 磨砂玻璃”；R-06 “跟随系统 / 浅色 / 深色”三选一，定稿线框写作“白天 / 夜间跟着手机”）：
// 两组单选，点哪个存哪个、马上换（platform/look.ts 的 watchLook 盯着 settings）。地址 #/settings/skin；顶栏和返回由设置页画（SubView）。
// 首页那一行（值“简洁 · 白天 / 夜间跟着手机”）是本文件的 SkinHomeRows，由 SettingsHome 放进卡 2。原来下面的两个开关（减少透明效果、减少动态效果）
// 11-14 负责人要求去掉，只跟系统设置（platform/look.ts）
import { SettingsChoiceCard, SettingsEntryRow } from '../../../kit/components/Settings/Settings.tsx';
import type { DeviceKind } from '../../../platform/device-kind.ts';
import { SKINS, THEMES, type Theme } from '../../../platform/look.ts';
import { useLookSetting } from '../hooks/useLookSetting.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import styles from './SettingsPage.module.css';

/** “跟随系统”按设备说成跟着手机 / 跟着电脑 */
export const themeKey = (v: Theme, kind: DeviceKind) => (v === 'system' ? (`settings.skin.theme.system.${kind}` as const) : (`settings.skin.theme.${v}` as const));

export function SkinSection() {
  const t = useSettingsT();
  const s = useLookSetting();
  return (
    <div data-testid="settings-skin">
      <SettingsChoiceCard
        title={t('settings.skin.title', {})}
        name="skin"
        options={SKINS.map((v) => ({ value: v, label: t(`settings.skin.${v}` as const, {}), testId: `settings-skin-${v}` }))}
        value={s.look.skin}
        onPick={(v) => void s.set('skin', v)}
      />
      <SettingsChoiceCard
        title={t('settings.skin.themeTitle', {})}
        showTitle
        name="theme"
        options={THEMES.map((v) => ({ value: v, label: t(themeKey(v, s.kind), {}), testId: `settings-theme-${v}` }))}
        value={s.look.theme}
        onPick={(v) => void s.set('theme', v)}
      />
      {s.error ? (
        <p className={styles.error} role="alert">
          {t('settings.skin.err', {})}
        </p>
      ) : null}
    </div>
  );
}

/** 设置首页的“皮肤”一组（定稿线框第 997 行、皮肤视觉稿第 1368 行）：一行“简洁 · 白天 / 夜间跟着手机 ›”点进二级页。
 *  原来下面的两个开关（R-84、R-93）11-14 按负责人要求去掉；写入出错的提示挪到这一行下面 */
export function SkinHomeRows({ onOpen }: { onOpen(): void }) {
  const t = useSettingsT();
  const s = useLookSetting();
  const { skin, theme } = s.look;
  return (
    <>
      <SettingsEntryRow
        rowId="skin"
        label={t('settings.skin.title', {})}
        value={t('settings.skin.value', {
          skin: t(`settings.skin.${skin}` as const, {}),
          theme: t(theme === 'system' ? (`settings.skin.themeSystemValue.${s.kind}` as const) : themeKey(theme, s.kind), {}),
        })}
        onOpen={onOpen}
        testId="settings-skin-entry"
        valueTestId="settings-skin-summary"
      />
      {s.error ? (
        <p className={styles.error} role="alert">
          {t('settings.skin.err', {})}
        </p>
      ) : null}
    </>
  );
}
