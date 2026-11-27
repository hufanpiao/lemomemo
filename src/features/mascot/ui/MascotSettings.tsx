// 设置 › 吉祥物：点哪个存哪个，今天页跟着换；#2 只有管理员看得到
import { SettingsChoiceCard, settingsNoteClass } from '../../../kit/components/Settings/Settings.tsx';
import { useSettingWriter } from '../../../kit/hooks/useSettingWriter.ts';
import { MASCOT_IDS, MASCOT_KEY, PRIVATE_ID, mascotValue, type MascotChoice } from '../hooks/mascot-data.ts';
import { useMascotChoice } from '../hooks/useMascotChoice.ts';
import { useMascotT } from '../hooks/useMascotT.ts';
import s from './Mascot.module.css';
import MascotPreview from './MascotPreview.tsx';

export default function MascotSettings() {
  const t = useMascotT();
  const { rows, save, error } = useSettingWriter();
  // 放哪只和今天页同一处判断（hooks/useMascotChoice.ts）：没手动选过或选的是 #2 时，等管理员身份读到才知道，免得先下一只再换
  const { id: value, admin } = useMascotChoice(rows, true);
  const ids: readonly MascotChoice[] = admin === true ? [PRIVATE_ID, ...MASCOT_IDS] : MASCOT_IDS;
  return (
    <div data-testid="settings-mascot">
      <MascotPreview key={value ?? 'wait'} id={value} />
      {/* 列表等管理员身份读到（最多 2 秒）再出：不先选中 Aldo、不先少一个 #2 再跳 */}
      {admin === null || value === null ? null : (
        <SettingsChoiceCard
          title={t('mascot.title', {})}
          name="mascot"
          options={ids.map((v) => ({ value: v, label: t(`mascot.name.${v}` as const, {}), testId: `settings-mascot-${v}` }))}
          value={value}
          onPick={(v: MascotChoice) => void save(MASCOT_KEY, mascotValue(v))}
        />
      )}
      {/* 页底说明：长按 AI 助手进入对话框 */}
      <p className={`${settingsNoteClass} ${s['hint'] ?? ''}`} data-testid="settings-mascot-hint">{t('mascot.hint', {})}</p>
      {error ? <p role="alert">{t('mascot.err', {})}</p> : null}
    </div>
  );
}
