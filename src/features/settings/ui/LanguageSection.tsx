// 设置 › 界面语言（中韩切换；架构 2.4 第 4 条、16.4）：排在账号之后（R-256 ①）
import { Pressable } from '../../../motion/components.ts';
import type { useSettingsPage } from '../hooks/useSettingsPage.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import styles from './SettingsPage.module.css';

type Page = ReturnType<typeof useSettingsPage>;

export function LanguageSection({ locale }: { locale: Page['locale'] }) {
  const t = useSettingsT();
  return (
    <section aria-labelledby="settings-lang-title">
      <ul className={styles.grp}>
        <li className={styles.row}>
          <h2 id="settings-lang-title" className={styles.tx}>
            {t('settings.lang.title', {})}
          </h2>
          <div className={styles.seg} role="group" aria-labelledby="settings-lang-title" data-testid="settings-lang">
            {(['zh', 'ko'] as const).map((l) => (
              <Pressable
                key={l}
                className={styles.segBtn}
                lang={l === 'ko' ? 'ko' : 'zh'}
                aria-pressed={locale.current === l}
                data-locale={l}
                onClick={() => void locale.choose(l)}
              >
                {t(l === 'ko' ? 'settings.lang.ko' : 'settings.lang.zh', {})}
              </Pressable>
            ))}
          </div>
        </li>
      </ul>
      <p className={styles.sn}>{t('settings.lang.note', {})}</p>
      {locale.sync === 'failed' ? (
        <p className={styles.error} role="alert">
          {t('settings.lang.syncFailed', {})}
        </p>
      ) : null}
    </section>
  );
}
