// 设置 › 关于：“手机时间不准”（接手清单 K8-clock；架构 4.3“时钟偏差”）：读 platform/clock 的 isClockWrong()（偏差超过 5 分钟）
// 只写一句“这台设备的时间和服务器差了约 N 分钟，提醒按服务器时间响。”（设计复审第二轮 N7：原来前面还有一句“这台设备的时间不准”，重复）
// 偏差正常时什么都不画；由设置页的“关于”分组经 reminders 的 index.ts 懒加载挂（见交付说明的接线清单）
import { useClockWrong } from '../hooks/useClockWrong.ts';
import { useRemindT } from '../hooks/useRemindT.ts';
import styles from './RemindSettings.module.css';

export default function ClockWrongNote() {
  const t = useRemindT();
  const c = useClockWrong();
  if (!c.wrong) return null;
  return (
    <p className={styles.error} role="status" data-testid="clock-wrong">
      {t('remind.clock.wrongNote', { min: c.minutes })}
    </p>
  );
}
