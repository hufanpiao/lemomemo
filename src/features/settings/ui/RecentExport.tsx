// 设置 › 账号 › 最近的导出（R-256 ②；架构 0.29 续第 96 条③）：列出 90 天里全部导出，按时间倒序。
// • 每行：日期和时刻（fmtWhen）、设备名、邮件没发出去时标“通知邮件没发出去”（发出去了不写）
// • 设备名不另查 devices 表：用设置页已读到的设备列表（DevicesSection 那份），按 logs.device 对上 devices.id；
//   本机加“本机”标签（复用 settings.devices.thisDevice）；列表里没有这一台（已移除）写“已移除的设备”；
//   导出时没带设备号、或设备列表还没读出来（分不清是不是已移除）写“未知设备”
// • 默认先显示最近 RECENT_EXPORT_SHOWN 条，多了给“显示全部（共 N 条）”
// • 只要有一次邮件没发出去，列表下方放一句提示（不每行重复）
// • 90 天里没有导出也写一句（不是本人操作时，用户能看出“明明没导出过”）；还在读、读失败、断网时整块不显示
import { useState } from 'react';
import { useUi } from '../../../kit/state/ui-store.ts';
import { Pressable } from '../../../motion/components.ts';
import type { DevicesState } from '../hooks/useDevices.ts';
import type { ExportEntry, RecentExportState } from '../hooks/useRecentExport.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import { deviceName, fmtWhen } from './DevicesSection.tsx';
import styles from './SettingsPage.module.css';

export const RECENT_EXPORT_SHOWN = 5;

type T = ReturnType<typeof useSettingsT>;

/** 这次导出用的设备：名字和是不是本机 */
export function exportDevice(e: ExportEntry, devices: DevicesState, t: T): { name: string; isCurrent: boolean } {
  if (!e.device || devices.kind !== 'ready') return { name: t('settings.recentExport.unknownDevice', {}), isCurrent: false };
  const d = devices.list.find((x) => x.id.toLowerCase() === e.device);
  if (!d) return { name: t('settings.recentExport.removedDevice', {}), isCurrent: false };
  return { name: deviceName(d, t), isCurrent: d.isCurrent };
}

export function RecentExport({ state, devices }: { state: RecentExportState; devices: DevicesState }) {
  const t = useSettingsT();
  const locale = useUi((s) => s.locale);
  const [all, setAll] = useState(false);
  if (state.kind !== 'ready' && state.kind !== 'none') return null;
  const list = state.kind === 'ready' ? state.list : [];
  const shown = all ? list : list.slice(0, RECENT_EXPORT_SHOWN);
  const anyFailed = list.some((e) => e.mailFailed);
  return (
    <section aria-labelledby="settings-recent-export-title" data-testid="settings-recent-export">
      <h3 id="settings-recent-export-title" className={styles.gt}>
        {t('settings.recentExport.title', {})}
      </h3>
      {list.length === 0 ? (
        <p className={styles.sn}>{t('settings.recentExport.none', {})}</p>
      ) : (
        <ul className={styles.grp}>
          {shown.map((e) => {
            const dev = exportDevice(e, devices, t);
            return (
              <li key={`${e.at}|${e.device ?? ''}`} className={styles.row} data-testid="settings-recent-export-row">
                <span className={styles.tx}>{fmtWhen(e.at, locale)}</span>
                <span className={styles.v}>
                  {dev.name}
                  {dev.isCurrent ? <span className={styles.tag}>{t('settings.devices.thisDevice', {})}</span> : null}
                </span>
                {e.mailFailed ? (
                  <p className={`${styles.meta} ${styles.danger}`} data-testid="settings-recent-export-mark">
                    {t('settings.recentExport.mailMark', {})}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {!all && list.length > RECENT_EXPORT_SHOWN ? (
        <Pressable className={`${styles.btn} ${styles.wide}`} onClick={() => setAll(true)} data-testid="settings-recent-export-all">
          {t('settings.recentExport.showAll', { n: list.length })}
        </Pressable>
      ) : null}
      {anyFailed ? (
        <p className={`${styles.sn} ${styles.danger}`} data-testid="settings-recent-export-mail">
          {t('settings.recentExport.mailFailed', {})}
        </p>
      ) : null}
    </section>
  );
}
