// 设置 › 提醒与通知 二级页正文（B2 FA-4；线框 s13 R_PUSH；数据字典第 9 节 remind.*；TC-B2-71、78、R-282 ③、第 105 条）
// 顶栏和返回由设置页画（照 calendar 的 CalendarSettings），这里只画正文：
// • 顶部提示（有才出）：推送被另一条设备记录占着 →“移除它”；推送需要重新打开 → 点一下；这个浏览器的推送服务暂不支持
// • 通知：已打开 / 未允许（去系统设置）/ “打开通知”按钮（在点按里请求权限，FA-1 留给这里）；exe 写“电脑版用 Windows 通知”
// • 提醒里写什么：直接写标题和名字（默认，R-46）/ 锁屏只显示“有 1 项日程”（remind.show_title = false，R-188）
// • 免打扰：开关 + 从 / 到两个时刻（remind.dnd）
// • 未来 7 天的提醒 ›（点了由设置页打开 RemindUpcoming，props.onOpenUpcoming）
// • 测试提醒能不能收到：发一条试试——网页版调 push-test，exe 弹本机测试通知（R-330）；结果写在下面
// 线框这一页的其余几行（日程默认提前、待办默认提醒、纪念日提醒、也装了电脑版时）不在 FA-4 范围，见交付说明
import { useId, useState } from 'react';
import { Pressable } from '../../../motion/components.ts';
import { isHm, upcoming } from '../hooks/remind-view.ts';
import { useMinuteNow, useReminderList } from '../hooks/useReminders.ts';
import { useRemindSettings, type TestResult } from '../hooks/useRemindSettings.ts';
import { useRemindT, type RemindT } from '../hooks/useRemindT.ts';
import { NoticeCard } from './RemindNotice.tsx';
import styles from './RemindSettings.module.css';

function testMsg(t: RemindT, r: TestResult | 'sending'): string {
  switch (r) {
    case 'sending':
      return t('remind.set.test.sending', {});
    case 'sent':
      return t('remind.set.test.sent', {});
    case 'no_device':
      return t('remind.set.test.noDevice', {});
    case 'resubscribe':
      return t('remind.set.test.resubscribe', {});
    case 'rate_limited':
      return t('remind.set.test.rate', {});
    case 'offline':
      return t('remind.set.test.offline', {});
    case 'failed':
      return t('remind.set.test.failed', {});
    case 'local_shown':
      return t('remind.set.test.localShown', {});
    case 'local_denied':
      return t('remind.set.test.localDenied', {});
    case 'local_failed':
      return t('remind.set.test.localFailed', {});
  }
}

type S = ReturnType<typeof useRemindSettings>;

/** “未来 7 天的提醒  N 条 ›”放在最上面，下面一句说明（线框 sR7，设计 M5） */
function UpcomingEntry({ ids, onOpen }: { ids: string; onOpen?: (() => void) | undefined }) {
  const t = useRemindT();
  const now = useMinuteNow();
  const { list, tz } = useReminderList(now);
  const n = upcoming(list, now, tz).reduce((k, d) => k + d.items.length, 0);
  return (
    <section aria-labelledby={`${ids}-up`}>
      <h2 id={`${ids}-up`} className={styles.srOnly}>
        {t('remind.set.upcoming', {})}
      </h2>
      <ul className={styles.grp}>
        <li className={styles.row}>
          <Pressable type="button" className={styles.rowBtn} onClick={() => onOpen?.()} data-testid="remind-open-upcoming">
            <b className={styles.tx}>{t('remind.set.upcoming', {})}</b>
            <span className={styles.v} data-testid="remind-upcoming-count">
              {t('remind.up.count', { n })}
            </span>
            <span className={styles.chev} aria-hidden>
              ›
            </span>
          </Pressable>
        </li>
      </ul>
      <p className={styles.sn}>{t('remind.set.upcoming.note', {})}</p>
    </section>
  );
}

/** 免打扰：开关 + 从 / 到 */
function DndSection({ s, ids }: { s: S; ids: string }) {
  const t = useRemindT();
  const [same, setSame] = useState(false);
  return (
    <section aria-labelledby={`${ids}-dnd`}>
      {/* 组标题只给读屏（行里已经写了“免打扰”，设计 M6 去重） */}
      <h2 id={`${ids}-dnd`} className={styles.srOnly}>
        {t('remind.set.dnd', {})}
      </h2>
      <ul className={styles.grp}>
        <li className={styles.row}>
          <label className={styles.tx} htmlFor={`${ids}-dnd-on`}>
            {t('remind.set.dnd', {})}
          </label>
          <input
            id={`${ids}-dnd-on`}
            type="checkbox"
            role="switch"
            className={styles.toggle}
            checked={s.dnd.enabled}
            onChange={(e) => void s.setDnd({ ...s.dnd, enabled: e.currentTarget.checked })}
            data-testid="remind-dnd-on"
          />
        </li>
        {s.dnd.enabled && (
          <li className={styles.row}>
            <label className={styles.timeLbl}>
              {t('remind.set.dnd.from', {})}
              <input
                type="time"
                className={styles.time}
                value={s.dnd.start}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setSame(v === s.dnd.end);
                  if (isHm(v) && v !== s.dnd.end) void s.setDnd({ ...s.dnd, start: v });
                }}
                data-testid="remind-dnd-start"
              />
            </label>
            <label className={styles.timeLbl}>
              {t('remind.set.dnd.to', {})}
              <input
                type="time"
                className={styles.time}
                value={s.dnd.end}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setSame(v === s.dnd.start);
                  if (isHm(v) && v !== s.dnd.start) void s.setDnd({ ...s.dnd, end: v });
                }}
                data-testid="remind-dnd-end"
              />
            </label>
          </li>
        )}
      </ul>
      {same && (
        <p className={styles.error} role="alert" data-testid="remind-dnd-same">
          {t('remind.set.dnd.same', {})}
        </p>
      )}
      <p className={styles.sn}>{t('remind.set.dnd.note', {})}</p>
    </section>
  );
}

export default function RemindSettings({ onOpenUpcoming }: { onOpenUpcoming?: () => void }) {
  const t = useRemindT();
  const s = useRemindSettings();
  const ids = useId();
  return (
    <div data-testid="settings-reminders">
      <NoticeCard s={s} />
      <UpcomingEntry ids={ids} onOpen={onOpenUpcoming} />

      <section aria-labelledby={`${ids}-n`}>
        <h2 id={`${ids}-n`} className={styles.srOnly}>
          {t('remind.set.notify', {})}
        </h2>
        <ul className={styles.grp}>
          <li className={styles.row}>
            <span className={styles.tx}>{t('remind.set.notify', {})}</span>
            {s.perm === 'default' ? (
              <Pressable type="button" className={styles.act} onClick={() => void s.enable()} data-testid="remind-enable">
                {t('remind.set.notify.enable', {})}
              </Pressable>
            ) : (
              <span className={styles.v} data-testid="remind-perm">
                {t(
                  s.perm === 'granted'
                    ? 'remind.set.notify.on'
                    : s.perm === 'tauri'
                      ? 'remind.set.notify.tauri'
                      : s.perm === 'unsupported'
                        ? 'remind.set.notify.unsupported'
                        : 'remind.set.notify.off',
                  {},
                )}
              </span>
            )}
          </li>
        </ul>
        {s.perm === 'denied' && <p className={styles.sn}>{t('remind.set.notify.denied', {})}</p>}
      </section>

      <section aria-labelledby={`${ids}-st`}>
        <h2 id={`${ids}-st`} className={styles.gt}>
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

      <DndSection s={s} ids={ids} />

      <section aria-labelledby={`${ids}-more`}>
        <h2 id={`${ids}-more`} className={styles.srOnly}>
          {t('remind.set.test', {})}
        </h2>
        <ul className={styles.grp}>
          <li className={styles.row}>
            <span className={styles.tx}>{t('remind.set.test', {})}</span>
            <Pressable type="button" className={styles.act} disabled={s.test === 'sending'} onClick={() => void s.sendTest()} data-testid="remind-test">
              {t('remind.set.test.btn', {})}
            </Pressable>
          </li>
        </ul>
        {s.test && (
          <p className={s.test === 'sent' || s.test === 'local_shown' ? styles.sn : styles.error} role="status" data-testid="remind-test-result" data-result={s.test}>
            {testMsg(t, s.test)}
          </p>
        )}
        {s.test === 'sent' && <p className={styles.sn}>{t('remind.set.test.help', {})}</p>}
      </section>

      {s.error && (
        <p className={styles.error} role="alert">
          {t('remind.set.saveFailed', {})}
        </p>
      )}
    </div>
  );
}
