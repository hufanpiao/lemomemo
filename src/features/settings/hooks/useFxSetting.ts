// 设置“声音和触感”的读写：键和“什么算开”在 platform/feedback.ts（FX_KEY、fxOnOf），这里只接到 kit 的 useSettingWriter
// （进 outbox、本机先生效，连点排队；同“完成 7 天后自动删除”）。界面是设置首页的一行开关（SettingsHome 的 fx）
import { useSettingWriter } from '../../../kit/hooks/useSettingWriter.ts';
import { FX_KEY, fxOnOf } from '../../../platform/feedback.ts';

export function useFxSetting(newId?: () => string) {
  const { rows, save, error } = useSettingWriter(newId);
  return { on: fxOnOf(rows), set: (v: boolean): Promise<boolean> => save(FX_KEY, v), error };
}
