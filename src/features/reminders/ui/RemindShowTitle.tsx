// 设置 › 提醒与通知 › 提醒里写什么（R-347：照线框 sR7 点进去再选；B2 FA-4；R-46、R-188）
// • 两个选项各一行、整行可点（label），选中的右边“✓”：直接写标题和名字（默认）/ 锁屏只显示“有 1 项日程”（remind.show_title = false）
// • 下面一句说明锁屏只显示时推送写什么。顶栏、返回由设置页画，这里只画正文；组标题只给读屏（顶栏已经写了）
import { useId } from 'react';
import { useRemindSettings } from '../hooks/useRemindSettings.ts';
import { useRemindT } from '../hooks/useRemindT.ts';
import styles from './RemindSettings.module.css';

export default function RemindShowTitle() {
  const t = useRemindT();
  const s = useRemindSettings();
  const ids = useId();
  return (
    <div data-testid="settings-remind-show-title">
      <section aria-labelledby={`${ids}-st`}>
        <h2 id={`${ids}-st`} className={styles.srOnly}>
          {t('remind.set.showTitle', {})}
        </h2>
        <div className={styles.grp} role="radiogroup" aria-labelledby={`${ids}-st`}>
          {[true, false].map((v) => (
            <label key={String(v)} className={styles.choice}>
              <input
                type="radio"
                className={styles.srOnly}
                name={`${ids}-show-title`}
                checked={s.showTitle === v}
                onChange={() => void s.setShowTitle(v)}
                data-testid={`remind-show-title-${v ? 'on' : 'off'}`}
              />
              <span className={styles.tx}>{t(v ? 'remind.set.showTitle.on' : 'remind.set.showTitle.off', {})}</span>
              <span className={styles.check} aria-hidden="true">
                {s.showTitle === v ? '✓' : ''}
              </span>
            </label>
          ))}
        </div>
        <p className={styles.sn}>{t('remind.set.showTitle.note', {})}</p>
      </section>
      {s.error && (
        <p className={styles.error} role="alert">
          {t('remind.set.saveFailed', {})}
        </p>
      )}
    </div>
  );
}
