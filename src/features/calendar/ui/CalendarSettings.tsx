// 设置 › 日历 二级页正文（B2 FA-3 第二段，架构 5.12 第 1 点、R-97；R-320 二级页）：节假日三选一、每周第一天
// • 设置首页只放一行入口（CalendarSettingsEntry.tsx），点进来是这一页，地址 #/settings/calendar；
//   由设置页经 calendar 的 index.ts 懒加载。顶栏“‹ 设置 / 日历”和返回由设置页画（和注销页同一个 .top，整个 src 只有那一处起 page-head 名，
//   切页时标题先出后入不叠字）；这里只画正文
// • 排法照设置页（设计审查 M8）：卡片上方组标题“节假日”，卡片里每个选项一行（44 高、有分隔线），选中的那一行右边打墨色“✓”；
//   读屏仍是一组单选（原生 radio 视觉隐藏，整行是它的 label，方向键照常切换）
// • 节假日：只显示中国 / 只显示韩国 / 两国都显示（cal.holidays）；没选过时亮的是跟界面语言推导出的那一个；点哪个存哪个（亮着的也存，R-97 选过即固定）
// • 每周第一天：周一 / 周日（cal.week_start）；没设时按界面语言（中文周一、韩文周日）
// • 不提农历、没有“显示农历”开关（R-321；负责人 11-04：二级页也不提农历）
// • 选了以后本机立刻生效（月历按新值画），同步到别的设备；写不进本机时提示“没保存上”
import type { HolidaySetting } from '../../../../shared/logic/calendar/holidays.ts';
import { useCalSettings } from '../hooks/useCalSettings.ts';
import { useCalViewT } from '../hooks/useCalViewT.ts';
import styles from './CalendarSettings.module.css';

const HOLIDAY_CHOICES: readonly HolidaySetting[] = ['cn', 'kr', 'both'];

function holKey(v: HolidaySetting): 'cal.set.hol.cn' | 'cal.set.hol.kr' | 'cal.set.hol.both' {
  switch (v) {
    case 'cn':
      return 'cal.set.hol.cn';
    case 'kr':
      return 'cal.set.hol.kr';
    case 'both':
      return 'cal.set.hol.both';
  }
}

export default function CalendarSettings() {
  const t = useCalViewT();
  const s = useCalSettings();
  return (
    <div data-testid="settings-calendar">
      <section aria-labelledby="settings-cal-hol">
        <h2 id="settings-cal-hol" className={styles.gt}>
          {t('cal.set.holidays', {})}
        </h2>
        <div className={styles.grp} role="radiogroup" aria-labelledby="settings-cal-hol">
          {HOLIDAY_CHOICES.map((v) => {
            const on = s.holidays === v;
            return (
              <label key={v} className={styles.choice} data-on={on ? '1' : undefined}>
                <input
                  type="radio"
                  className={styles.srOnly}
                  name="cal-holidays"
                  value={v}
                  checked={on}
                  // 用 click 不用 change：点亮着的那一个也要存（change 不触发）；方向键切换时浏览器同样派 click
                  onChange={() => undefined}
                  onClick={() => void s.setHolidays(v)}
                  data-testid={`settings-cal-hol-${v}`}
                />
                <span className={styles.tx}>{t(holKey(v), {})}</span>
                <span className={styles.check} aria-hidden="true">
                  {on ? '✓' : ''}
                </span>
              </label>
            );
          })}
        </div>
        <p className={styles.sn}>{t('cal.set.holNote', {})}</p>
      </section>
      <section aria-labelledby="settings-cal-ws">
        <ul className={styles.grp}>
          <li className={styles.row}>
            <h2 id="settings-cal-ws" className={styles.tx}>
              {t('cal.set.weekStart', {})}
            </h2>
            <div className={styles.seg} role="group" aria-labelledby="settings-cal-ws">
              <button type="button" className={styles.segBtn} aria-pressed={s.weekStart === 1} onClick={() => void s.setWeekStart(1)} data-testid="settings-cal-ws-1">
                {t('cal.set.ws.1', {})}
              </button>
              <button type="button" className={styles.segBtn} aria-pressed={s.weekStart === 0} onClick={() => void s.setWeekStart(0)} data-testid="settings-cal-ws-0">
                {t('cal.set.ws.0', {})}
              </button>
            </div>
          </li>
        </ul>
      </section>
      {s.error ? (
        <p className={styles.error} role="alert">
          {t('cal.set.saveFailed', {})}
        </p>
      ) : null}
    </div>
  );
}
