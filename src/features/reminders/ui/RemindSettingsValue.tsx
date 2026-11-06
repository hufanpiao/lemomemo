// 设置首页“提醒与通知”一行右边的值（B2 FA-4；定稿线框 s13：“提醒与通知 … 通知已打开 ›”；SETTINGS-merge-cards M4）：
// 整行、行名、点了进二级页都由设置页（kit 的 SettingsEntryRow）画，原来自带的那个看不见的 h2 也去掉了（M3）；这里只给值的文字
// • 摘要：通知已打开 / 通知没开；exe 写“Windows 通知”
import { usePermState } from '../hooks/useRemindSettings.ts';
import { useRemindT } from '../hooks/useRemindT.ts';

export default function RemindSettingsValue() {
  const t = useRemindT();
  const [perm] = usePermState();
  const summary = perm === 'tauri' ? 'remind.set.summary.desk' : perm === 'granted' ? 'remind.set.summary.on' : 'remind.set.summary.off';
  return <>{t(summary, {})}</>;
}
