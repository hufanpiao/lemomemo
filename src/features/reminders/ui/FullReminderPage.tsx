// 整页提醒（B2 FA-4；架构 5.3“整页提醒地址”“iPhone”、R-52、R-85；线框 FULLALERT；TC-B6X-11）
// • 地址 #/remind/<kind>/<id>?due=<dueAt>：自己再校验 kind、id、due（FE-3，parseReminderHash），不认任何别的参数；不合格显示“这条提醒找不到了”
// • 点推送、exe 的通知、横幅、错过的提醒都进这里；按钮在屏幕下方，按类型和横幅一样（actionsFor）
// • 这一次（due）已经处理过（别的设备按了知道了 / 稍后、待办完成、删掉、改了时间）：写“已在其他设备上处理”（R-328 中性说法），只给“回到今天”
//   （iPhone 不发 resolve、已送达的通知收不回，5.3；线框“仍待确认”第 2 条）
// • 处理完：队列里还有下一条就换成下一条，没有了就回到原来的页面（5.9“队列处理完回到原来的页面”）
import { useState, useSyncExternalStore } from 'react';
import { LocationText } from '../../../kit/components/LocationText.tsx';
import { useRemindQueue } from '../../../kit/state/remind-queue.ts';
import { backTo } from '../../../app/router.ts';
import { backOr } from '../../../app/router-levels.ts';
import { BackLink } from '../../../kit/components/BackLink.tsx';
import { Pressable } from '../../../motion/components.ts';
import { clock } from '../../../platform/clock.ts';
import { reminderHash, type ReminderKind } from '../../../platform/native-bridge.ts';
import { useMinuteNow } from '../../../kit/hooks/useMinuteNow.ts';
import { eventEnd, eventStart, findReminder, parseReminderHash, relMsg, timeOf, type Reminder } from '../hooks/remind-view.ts';
import { actionsOf, useReminderList, useRemindActions } from '../hooks/useReminders.ts';
import { useRemindT } from '../hooks/useRemindT.ts';
import { Bell } from './Bell.tsx';
import { markClass, pcClass } from './pc-class.ts';
import { RemindButtons } from './RemindButtons.tsx';
import styles from './Remind.module.css';

const subscribeHash = (cb: () => void): (() => void) => {
  window.addEventListener('hashchange', cb);
  window.addEventListener('popstate', cb);
  return () => {
    window.removeEventListener('hashchange', cb);
    window.removeEventListener('popstate', cb);
  };
};
const getHash = (): string => window.location.hash;

/** 大时刻（视觉稿 .fa-big）：日程是开始时刻，待办有截止时刻写截止时刻、没有写这次提醒的时刻 */
function bigTimeOf(r: Reminder, tz: string, defaultTime: string): string {
  if (r.kind === 'event') {
    const s = eventStart(r, tz, defaultTime);
    return timeOf(s ?? r.tagDue, tz);
  }
  const dueTime = r.row['due_time'];
  return typeof dueTime === 'string' && /^\d{2}:\d{2}/.test(dueTime) ? dueTime.slice(0, 5) : timeOf(r.tagDue, tz);
}

// 按层级记历史（R-372，负责人 11-10“往左滑应该是返回上一个层级，不是返回上一个操作”）：连看几条提醒算同一层，
// 左滑一步就离开整页提醒；关闭能退就退一步，退不了（直接打开、iOS 恢复后）原地换成今天，不新压一条

/** 换成下一条：原地换这条历史（保留 state 里的深度、编号），再按地址变了通知路由和本页重画 */
function showNext(kind: ReminderKind, id: string, dueAt: number): void {
  const oldURL = window.location.href;
  window.history.replaceState(window.history.state, '', reminderHash(kind, id, dueAt));
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: window.location.href }));
}

const leave = (): void => backOr('today');

export default function FullReminderPage() {
  const t = useRemindT();
  const hash = useSyncExternalStore(subscribeHash, getHash, () => '');
  const ref = parseReminderHash(hash);
  const now = useMinuteNow();
  const { list, tz, prefs } = useReminderList(now);
  const entries = useRemindQueue((s) => s.entries);
  const { complete } = useRemindActions();
  const r = ref ? findReminder(list, ref.kind, ref.id) : undefined;
  const live = !!r && !r.handled && r.tagDue === ref?.dueAt;
  /** 在这一页上刚处理掉的 tag：跳走之前不显示“已在其他设备上处理”（R-328 照旧压住） */
  const [doneHere, setDoneHere] = useState<string | null>(null);
  /** 完成圆圈没写进去：提示，不跳走（设计 L1） */
  const [doneFail, setDoneFail] = useState(false);

  const after = (cur: Reminder): void => {
    setDoneHere(cur.tag);
    const next = entries.find((e) => e.tag !== cur.tag);
    if (next) showNext(next.kind, next.id, next.dueAt);
    else leave();
  };

  const top = (
    <div className={styles.top}>
      <BackLink label={t('remind.full.back', {})} onBack={leave} testId="remind-full-back" />
      {live && entries.length > 1 && (
        <span className={styles.dim}>{t('remind.full.pos', { i: Math.max(1, entries.findIndex((e) => e.tag === r.tag) + 1), n: entries.length })}</span>
      )}
    </div>
  );

  if (r && !live && doneHere === r.tag) return <main className={styles.page} data-testid="remind-full">{top}</main>;
  if (!ref || !r || !live) {
    const known = !!ref && !!r;
    return (
      <main className={styles.page} data-testid="remind-full">
        {top}
        <div className={styles.card}>
          <p className={styles.state} data-testid={known ? 'remind-full-handled' : 'remind-full-gone'}>
            {t(known ? 'remind.full.handled' : 'remind.full.gone', {})}
          </p>
          {r && <p>{r.title}</p>}
          <p className={styles.dim}>{t(known ? 'remind.full.handledNote' : 'remind.full.goneNote', {})}</p>
        </div>
        <div className={styles.spacer} />
        <div className={styles.pageBar}>
          <Pressable type="button" className={`${styles.btn} ${styles.primary}`} onClick={() => backTo('today')}>
            {t('remind.full.home', {})}
          </Pressable>
        </div>
      </main>
    );
  }

  // 类型行写“还有多久”，大号字写时刻，不重复（设计复审 今天页待办 M3）；页面每分钟随 useMinuteNow 重画
  const w = relMsg(r, clock.now(), tz, prefs.defaultTime);
  const end = r.kind === 'event' ? eventEnd(r, tz) : null;
  const loc = typeof r.row['location'] === 'string' ? r.row['location'] : '';
  const note = typeof r.row['note'] === 'string' ? r.row['note'] : '';
  const project = typeof r.row['project'] === 'string' ? r.row['project'] : '';
  const next = entries.find((e) => e.tag !== r.tag);
  const nextR = next ? findReminder(list, next.kind, next.id) : undefined;
  const nextProject = nextR && typeof nextR.row['project'] === 'string' ? nextR.row['project'] : '';

  return (
    <main className={styles.page} data-testid="remind-full" data-kind={r.kind}>
      {top}
      {/* 线框 FULLALERT（设计 H1）：铃铛 + 类型行、大时刻、标题（待办的完成圆圈并排，不在 h1 里，L1）、“到 16:30 · 项目”、地点备注卡、下一条卡 */}
      <p className={styles.kind} data-testid="remind-full-kind">
        <Bell className={styles.bell} />
        {t(`remind.full.head.${r.kind}`, { when: t(w.key, w.params as never) })}
      </p>
      <p className={styles.bigTime} data-testid="remind-full-time">
        {bigTimeOf(r, tz, prefs.defaultTime)}
      </p>
      <div className={styles.titleRow}>
        {r.kind === 'todo' && (
          <button
            type="button"
            className={`${styles.circle} ${pcClass(project)}`}
            aria-label={t('remind.full.doneA11y', {})}
            data-testid="remind-full-done"
            onClick={async () => {
              setDoneHere(r.tag);
              const res = await complete(r);
              if (res === 'ok') after(r);
              else {
                setDoneHere(null);
                setDoneFail(res !== 'silent');
              }
            }}
          />
        )}
        <h1 className={styles.bigTitle}>{r.title}</h1>
      </div>
      {(end !== null || project) && (
        <p className={styles.sub} data-testid="remind-full-sub">
          {[end !== null ? t('remind.full.until', { time: timeOf(end, tz) }) : '', project].filter(Boolean).join(' · ')}
        </p>
      )}
      {doneFail && (
        <p className={styles.error} role="alert">
          {t('remind.saveFailed', {})}
        </p>
      )}
      {(loc || note) && (
        <div className={styles.card} data-testid="remind-full-detail">
          {loc && (
            <dl className={styles.fld}>
              <dt>{t('remind.full.loc', {})}</dt>
              <dd>
                <LocationText text={loc} />
              </dd>
            </dl>
          )}
          {note && (
            <dl className={styles.fld}>
              <dt>{t('remind.full.note', {})}</dt>
              <dd>{note}</dd>
            </dl>
          )}
        </div>
      )}
      {nextR && next && (
        <Pressable type="button" className={styles.nextCard} onClick={() => showNext(next.kind, next.id, next.dueAt)} data-testid="remind-full-next">
          <span className={`${markClass(nextR.kind)} ${pcClass(nextProject)}`} aria-hidden="true" />
          <span className={styles.grow}>
            <b className={styles.nextTitle}>{t('remind.full.next', { title: nextR.title })}</b>
            <span className={styles.nextSub}>
              {[t('remind.full.nextAt', { time: timeOf(next.dueAt, tz) }), t(nextR.kind === 'todo' ? 'remind.kindAlert.todo' : `remind.kindName.${nextR.kind}`, {}), nextProject].filter(Boolean).join(' · ')}
            </span>
          </span>
          <span aria-hidden="true">›</span>
        </Pressable>
      )}
      <div className={styles.spacer} />
      <div className={styles.pageBar} role="group" aria-label={t('remind.a11y.region', {})}>
        <RemindButtons key={r.tag} layout="page" r={r} actions={actionsOf(r, clock.now(), tz, prefs)} onBefore={() => setDoneHere(r.tag)} onDone={() => after(r)} />
      </div>
    </main>
  );
}
