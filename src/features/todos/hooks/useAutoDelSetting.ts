// 设置“完成 7 天后自动删除”的读写（负责人 11-15 方案）：键和“什么算开”在 data/todo-autodel.ts（AUTODEL_KEY、autoDelOn），这里只接到 kit 的 useSettingWriter
// （进 outbox、本机先生效，连点排队；同随手记显示方式、日历设置）。界面在 ui/TodoSettings.tsx
import { useSettingWriter } from '../../../kit/hooks/useSettingWriter.ts';
import { AUTODEL_KEY, autoDelOn } from '../data/todo-autodel.ts';

export function useAutoDelSetting(newId?: () => string) {
  const { rows, save, error } = useSettingWriter(newId);
  return { on: autoDelOn(rows), set: (v: boolean): Promise<boolean> => save(AUTODEL_KEY, v), error };
}
