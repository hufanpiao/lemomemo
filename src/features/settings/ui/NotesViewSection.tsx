// 设置 › 随手记显示方式 二级页正文（首页一行“随手记显示方式 · 瀑布流 · 只对本类设备生效 ›”）：
// 两个选项（瀑布流 / 列表），下面同一句说明；点哪个存哪个，只对本类设备生效（手机、电脑各设各的）
// 下面两张排序卡：随手记排序、隐私记排序，各两个选项（按时间 / 自己排），各记各的；在随手记页长按拖过一次会自己切到“自己排”，这里切回
// 地址 #/settings/notes-view；顶栏和返回由设置页画（SubView）。首页那一行（值和行下面的小字）在 SettingsHome
import { SettingsChoiceCard } from '../../../kit/components/Settings/Settings.tsx';
import { ORDER_KEYS, useNoteOrderSetting, useNotesViewSetting, type NoteOrder, type NotesView } from '../hooks/useNotesViewSetting.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import styles from './SettingsPage.module.css';

const CHOICES: readonly NotesView[] = ['masonry', 'list'];
const ORDERS: readonly NoteOrder[] = ['time', 'manual'];

export function NotesViewSection() {
  const t = useSettingsT();
  const s = useNotesViewSetting();
  const o = useNoteOrderSetting();
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
      {ORDER_KEYS.map((k) => {
        const id = k === 'notes.order' ? 'notes' : 'vault';
        return (
          <SettingsChoiceCard
            key={k}
            title={t(id === 'notes' ? 'settings.notesOrder.notes' : 'settings.notesOrder.vault', {})}
            name={`${id}-order`}
            options={ORDERS.map((v) => ({ value: v, label: t(v === 'manual' ? 'settings.notesOrder.manual' : 'settings.notesOrder.time', {}), testId: `settings-${id}-order-${v}` }))}
            value={o.order(k)}
            onPick={(v) => void o.set(k, v)}
            note={t('settings.notesOrder.note', {})}
          />
        );
      })}
      {s.error || o.error ? (
        <p className={styles.error} role="alert">
          {t('settings.notesView.err', {})}
        </p>
      ) : null}
    </div>
  );
}
