// 设置 › 字体（架构 5.9c；R-128、R-135；定稿线框 s13“字体 › 系统字体（默认）”）：
// • 首页一行 FontHomeRow：值是选中的字体名；下载中写“下载中 xx%”，失败写“没下载成功，先用系统字体”。点进 #/settings/font
// • 二级页 FontSection：一组单选（系统字体 + 清单里有的字体，清单由 build/fonts.py 生成，加字体不改这里），下面一句说明；失败时一句提示和“重试”。
//   点哪个存哪个（ui.font），下载、套上由 platform/look.ts → platform/fonts.ts 做，没确认加载好之前一直是系统字体
import { FormButton } from '../../../kit/components/Form.tsx';
import { SettingsChoiceCard, SettingsEntryRow } from '../../../kit/components/Settings/Settings.tsx';
import { useFontSetting } from '../hooks/useFontSetting.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import styles from './SettingsPage.module.css';

export function FontSection() {
  const t = useSettingsT();
  const f = useFontSetting(true);
  return (
    <div data-testid="settings-font">
      <SettingsChoiceCard
        title={t('settings.font.title', {})}
        name="font"
        options={[
          { value: 'system', label: t('settings.font.system', {}), testId: 'settings-font-system' },
          ...f.fonts.map((x) => ({ value: x.id, label: f.label(x), testId: `settings-font-${x.id}` })),
        ]}
        value={f.value}
        onPick={(v) => void f.pick(v)}
      />
      <p className={styles.status}>{t('settings.font.note', {})}</p>
      {f.state.status === 'fail' ? (
        <div role="alert">
          <p className={styles.error}>{t('settings.font.fail', {})}</p>
          <FormButton size="compact" onClick={f.retry}>
            {t('settings.font.retry', {})}
          </FormButton>
        </div>
      ) : null}
      {f.error ? (
        <p className={styles.error} role="alert">
          {t('settings.font.err', {})}
        </p>
      ) : null}
    </div>
  );
}

export function FontHomeRow({ onOpen }: { onOpen(): void }) {
  const t = useSettingsT();
  const f = useFontSetting();
  const value =
    f.state.status === 'loading'
      ? t('settings.font.loading', { pct: String(f.state.pct) })
      : f.state.status === 'fail'
        ? t('settings.font.failShort', {})
        : (f.chosenLabel ?? t('settings.font.systemValue', {}));
  return <SettingsEntryRow rowId="font" label={t('settings.font.title', {})} value={value} onOpen={onOpen} testId="settings-font-entry" valueTestId="settings-font-summary" />;
}
