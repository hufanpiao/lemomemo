// 设置首页“完成 7 天后自动删除”一行（负责人 11-15 方案）：开关，默认开；存 settings 的 todo.autodel（各设备同步），
// 键、默认值和“什么算开”只在 data/todo-autodel.ts（autoDelOn）。设置页按需下载这一块（功能入口 index.ts 的 TodoSettings），整行由这里画
// • 读写在 hooks/useAutoDelSetting.ts（kit 的 useSettingWriter）
// • 说明后面接一个“最近删除”链接（审查 11-15 第 2 条：自动删掉的去哪找，kit 的 TrashLink inline，去 #/trash）
import { SettingsSwitchRow } from '../../../kit/components/Settings/Settings.tsx';
import { TrashLink } from '../../../kit/components/TrashLink.tsx';
import { useAutoDelSetting } from '../hooks/useAutoDelSetting.ts';
import { useListT } from '../hooks/useTodoList.ts';

export default function TodoSettings() {
  const t = useListT();
  const s = useAutoDelSetting();
  return (
    <SettingsSwitchRow
      rowId="todos"
      label={t('settings.autodel', {})}
      checked={s.on}
      onChange={(v) => void s.set(v)}
      note={
        <>
          {t('settings.autodel.note', {})}
          <TrashLink look="inline" to={['trash']} label={t('list.trash', {})} testId="settings-todo-trash" />
        </>
      }
      error={s.error ? t('list.err.save', {}) : null}
      testId="settings-todo-autodel"
    />
  );
}
