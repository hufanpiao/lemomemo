// 提醒响起时（B2 FA-4；架构 5.9“提醒的排队规则”；线框 s1b；TC-B2-22）：挂在 App 上一份
// • 跑提醒引擎（useRemindEngine）：每分钟把到点的放进队列、键盘弹起时压住、exe 弹本机通知、打开时收回已处理的系统通知
// • 其他页面（待办、日历、随手记、设置）：顶部横幅只写类型和标题（点它看详情 = 整页提醒）；待办标题前有可点的完成圆圈
// • 按钮统一放在屏幕下方（今天页、其他页面同一位置、同一组件）；今天页上“现在”卡原地变成提醒由今天页读 kit 的队列自己画，这里只画按钮条
// • 正在录音或键盘弹起时先排队（kit/state/remind-queue 的 holds），放开后一条一条出；隐私记解锁中照常出
// • 横幅不自动收起，处理了才消失；往上滑（或点“先收起”）先收起，收起的进“错过的提醒”
// • 按了“稍后”弹 2 秒“15:25 再提醒你”
// • 整页提醒那一页（route = 'remind'）不画横幅和按钮条（整页里有自己的按钮）
// • exe 退出登录（接线审查 R3）：要等会话真删掉（最多 3 秒，platform/session.ts）才整页重新载入，这段时间里 RemindHost 还挂着，
//   引擎碰上整分钟还会再算一次；退出流程先清了本机库，集合已经是空的，弹不出本机通知，所以不另设“停止”标记
import { useRef, useState } from 'react';
import { collapseRinging, useRemindQueue, visibleEntry } from '../../../kit/state/remind-queue.ts';
import { Appear } from '../../../motion/components.ts';
import { clock } from '../../../platform/clock.ts';
import { openReminder } from './open-reminder.ts';
import { useMinuteNow } from '../../../kit/hooks/useMinuteNow.ts';
import { findReminder, timeOf, whenMsg, type Reminder } from '../hooks/remind-view.ts';
import { actionsOf, useReminderList, useRemindEngine, useRemindActions } from '../hooks/useReminders.ts';
import { useRemindT } from '../hooks/useRemindT.ts';
import { pcClass } from './pc-class.ts';
import { RemindButtons } from './RemindButtons.tsx';
import styles from './Remind.module.css';

/** 往上滑多少 px 算收起 */
const SWIPE_UP_PX = 30;
/** 手指动了多少 px 就不算点按（之后的 click 吞掉，设计 M1） */
const DRAG_PX = 8;

/** 顶部横幅（线框 TODOBAN，设计 M1、M2、L1、L4）：
 *  [完成圆圈（待办，项目色）] [类型 · 时刻 / 标题 16px 常规 / 还有 N 条] [详情 ›]，下面一条抓手条，旁边“先收起”小按钮（不会滑的人也能收起）；
 *  往上滑跟手（transform），超过 30px 收起；滑动成立后随后的 click 在捕获阶段拦掉，不会顺手打开整页提醒 */
function Banner({ r, queued, tz, defaultTime }: { r: Reminder; queued: number; tz: string; defaultTime: string }) {
  const t = useRemindT();
  const { complete } = useRemindActions();
  const startY = useRef<number | null>(null);
  const dragged = useRef(false);
  const [dy, setDy] = useState(0);
  /** 手指按着时跟手（不加过渡）；松手后回位走 .settling 的 --dur-ui，减少动态效果时直接回位（设计 N2） */
  const [dragging, setDragging] = useState(false);
  const [doneFail, setDoneFail] = useState(false);
  const project = typeof r.row['project'] === 'string' ? r.row['project'] : '';
  const w = whenMsg(r, clock.now(), tz, defaultTime);

  return (
    <section
      className={dragging ? styles.banner : `${styles.banner} ${styles.settling}`}
      aria-label={t('remind.a11y.region', {})}
      aria-live="polite"
      data-testid="remind-banner"
      style={dy < 0 ? { transform: `translateY(${dy}px)` } : undefined}
      onPointerDown={(e) => {
        startY.current = e.clientY;
        dragged.current = false;
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (startY.current === null) return;
        const d = e.clientY - startY.current;
        if (Math.abs(d) > DRAG_PX) dragged.current = true;
        setDy(Math.min(0, d));
      }}
      onPointerUp={(e) => {
        const y0 = startY.current;
        startY.current = null;
        setDragging(false);
        setDy(0);
        if (y0 !== null && y0 - e.clientY > SWIPE_UP_PX) {
          dragged.current = true;
          collapseRinging(r.tag);
        }
      }}
      onPointerCancel={() => {
        startY.current = null;
        setDragging(false);
        setDy(0);
      }}
      onClickCapture={(e) => {
        if (!dragged.current) return;
        dragged.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className={styles.bannerRow}>
        {r.kind === 'todo' && (
          <button
            type="button"
            className={`${styles.circle} ${pcClass(project)}`}
            aria-label={t('remind.full.doneA11y', {})}
            data-testid="remind-banner-done"
            onClick={async () => {
              const res = await complete(r);
              setDoneFail(res === 'failed' || res === 'readonly');
            }}
          />
        )}
        <button type="button" className={styles.bannerMain} data-testid="remind-banner-open" onClick={() => void openReminder(r.kind, r.id, r.tagDue)}>
          <span className={styles.bannerText}>
            <span className={styles.kicker}>
              {t(`remind.banner.${r.kind}`, { when: t(w.key, w.params as never) })}
            </span>
            <span className={styles.title}>{r.title}</span>
            {queued > 1 && <span className={styles.more}>{t('remind.banner.more', { n: queued - 1 })}</span>}
          </span>
          <span className={styles.detail}>{t('remind.banner.detail', {})}</span>
        </button>
      </div>
      {doneFail && (
        <p className={styles.error} role="alert">
          {t('remind.saveFailed', {})}
        </p>
      )}
      {/* “先收起”在抓手条左边，点按区只往下扩，不伸进上面的“详情 ›”（设计 N1） */}
      <div className={styles.grabRow}>
        <button type="button" className={styles.collapse} onClick={() => collapseRinging(r.tag)} data-testid="remind-banner-collapse">
          {t('remind.banner.collapse', {})}
        </button>
        <span className={styles.grab} aria-hidden="true" />
      </div>
    </section>
  );
}

export default function RemindHost({ route, since }: { route?: string | undefined; since?: number | undefined }) {
  useRemindEngine(since);
  const t = useRemindT();
  const now = useMinuteNow();
  const { list, tz, prefs } = useReminderList(now);
  const entry = useRemindQueue(visibleEntry);
  const queued = useRemindQueue((s) => s.entries.length);
  const note = useRemindQueue((s) => s.snoozeNote);

  const r = entry ? findReminder(list, entry.kind, entry.id) : undefined;
  const onFull = route === 'remind';
  const showBanner = !!r && !onFull && route !== 'today';
  const showBar = !!r && !onFull;

  return (
    <>
      <Appear kind="toast" show={showBanner} className={styles.layer}>
        {r && <Banner key={r.tag} r={r} queued={queued} tz={tz} defaultTime={prefs.defaultTime} />}
      </Appear>
      <Appear kind="toast" show={showBar && note === null} className={styles.layer}>
        {r && (
          <div className={styles.bar} role="group" aria-label={t('remind.a11y.region', {})} data-testid="remind-bar" data-kind={r.kind}>
            <RemindButtons key={r.tag} r={r} actions={actionsOf(r, clock.now(), tz, prefs)} />
          </div>
        )}
      </Appear>
      <Appear kind="toast" show={note !== null} className={styles.layerNote}>
        {note !== null && (
          <p className={styles.note} role="status" data-testid="remind-snooze-note">
            {t('remind.snoozed', { time: timeOf(note, tz) })}
          </p>
        )}
      </Appear>
    </>
  );
}
