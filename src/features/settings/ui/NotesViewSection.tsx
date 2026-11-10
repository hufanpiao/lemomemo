// 设置 › 随手记显示方式 二级页正文（B4 S1；R-53、R-78；TC-B4-01；定稿线框第 997 行“随手记显示方式 · 瀑布流 · 只对本类设备生效 ›”，
// 皮肤视觉稿第 1368 行“只对手机生效，电脑另外设”）：两个选项（瀑布流 / 列表），下面同一句说明；点哪个存哪个，只对本类设备生效
// 地址 #/settings/notes-view；顶栏和返回由设置页画（SubView）。首页那一行（值和行下面的小字）在 SettingsHome
import { SettingsChoiceCard } from '../../../kit/components/Settings/Settings.tsx';
import { useNotesViewSetting, type NotesView } from '../hooks/useNotesViewSetting.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import styles from './SettingsPage.module.css';

const CHOICES: readonly NotesView[] = ['masonry', 'list'];

export function NotesViewSection() {
  const t = useSettingsT();
  const s = useNotesViewSetting();
  return (
    <div data-testid="settings-notes-view">
      <SettingsChoiceCard
        title={t('settings.notesView.title', {})}
        name="notes-view"
        options={CHOICES.map((v) => ({ value: v, label: t(v === 'list' ? 'settings.notesView.list' : 'settings.notesView.masonry', {}), testId: `settings-notes-view-${v}` }))}
        value={s.view}
        onPick={(v) => void s.set(v)}
        note={t(s.kind === 'mobile' ? 'settings.notesView.mobileNote' : 'settings.notesView.desktopNote', {})}
      />
      {s.error ? (
        <p className={styles.error} role="alert">
          {t('settings.notesView.err', {})}
        </p>
      ) : null}
    </div>
  );
}
