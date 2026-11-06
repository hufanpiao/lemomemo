// 设置 › 界面语言（中韩切换；架构 2.4 第 4 条、16.4）：首页卡 2 的第一行（R-256 ①、R-325）
// 留分段按钮，和线框“中文 ›”是一处有意差别（SETTINGS-merge-cards 方案 C）；说明缩短成行里第二行灰字（M1），同步失败的报错也写在这一行里
import { SettingsSegRow } from '../../../kit/components/Settings/Settings.tsx';
import type { useSettingsPage } from '../hooks/useSettingsPage.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';

type Page = ReturnType<typeof useSettingsPage>;

export function LanguageSection({ locale }: { locale: Page['locale'] }) {
  const t = useSettingsT();
  return (
    <SettingsSegRow
      label={t('settings.lang.title', {})}
      options={[
        { value: 'zh', label: t('settings.lang.zh', {}), lang: 'zh' },
        { value: 'ko', label: t('settings.lang.ko', {}), lang: 'ko' },
      ]}
      value={locale.current}
      onChange={(l) => void locale.choose(l)}
      testId="settings-lang"
      rowId="language"
      meta={t('settings.lang.note', {})}
      error={locale.sync === 'failed' ? t('settings.lang.syncFailed', {}) : null}
    />
  );
}
