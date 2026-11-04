// 设置 › 提醒与通知 顶部的提示卡（B2 FA-4；第 105 条、TC-B2-71；设计 M7、代码审查中 3 / 低 4）：
// 推送被同账号另一条设备记录占着 →“移除它…”（先确认：移除哪台、最近使用日期、移除后那台收不到提醒）；
// 移除成功但再认领没接上 →“重新接上”（只再认领）；推送需要重新打开 → 点一下；这个浏览器的推送服务暂不支持
import { useState } from 'react';
import { Dialog } from '../../../kit/components/Dialog.tsx';
import { useUi } from '../../../kit/state/ui-store.ts';
import { Pressable } from '../../../motion/components.ts';
import type { useRemindSettings } from '../hooks/useRemindSettings.ts';
import { useRemindT, type RemindT } from '../hooks/useRemindT.ts';
import styles from './RemindSettings.module.css';

function fmtDate(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).format(ms);
  } catch {
    return null;
  }
}

type S = ReturnType<typeof useRemindSettings>;

/** 移除结果的提示文字 */
function removeMsg(t: RemindT, r: NonNullable<S['remove']>): string | null {
  if (r === 'ok') return t('remind.set.inUse.removed', {});
  if (r === 'reclaim_failed') return t('remind.set.inUse.reclaimFailed', {});
  if (r === 'offline') return t('remind.set.inUse.offline', {});
  if (r === 'failed') return t('remind.set.inUse.failed', {});
  return null;
}

/** 推送被占着：说明 + “移除它…”（先确认，写清移除哪台、移除后那台收不到提醒；设计 M7、代码审查低 4）；
 *  移除成功但再认领没接上时换成“重新接上”（只再认领，不再调 remove_device；代码审查中 3） */
function InUse({ s, n }: { s: S; n: Extract<NonNullable<S['notice']>, { kind: 'in_use' }> }) {
  const t = useRemindT();
  const locale = useUi((x) => x.locale);
  const [confirm, setConfirm] = useState(false);
  const label = n.holder.label ?? t('remind.set.inUse.noLabel', {});
  const date = fmtDate(n.holder.last_seen_at, locale) ?? t('remind.set.inUse.noDate', {});
  const afterRemove = s.remove === 'reclaim_failed' || s.remove === 'reclaiming';
  return (
    <>
      <p className={styles.noticeText}>{n.self ? t('remind.set.inUse.self', {}) : t('remind.set.inUse.other', { label, date })}</p>
      {afterRemove ? (
        <Pressable type="button" className={styles.act} disabled={s.remove === 'reclaiming'} data-testid="remind-reconnect" onClick={() => void s.reconnect()}>
          {t(s.remove === 'reclaiming' ? 'remind.set.inUse.reconnecting' : 'remind.set.inUse.reconnect', {})}
        </Pressable>
      ) : (
        s.remove !== 'ok' && (
          <Pressable
            type="button"
            className={styles.danger}
            disabled={s.remove === 'removing'}
            data-testid="remind-remove-holder"
            onClick={() => setConfirm(true)}
          >
            {t(s.remove === 'removing' ? 'remind.set.inUse.removing' : 'remind.set.inUse.remove', {})}
          </Pressable>
        )
      )}
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('remind.set.inUse.confirmTitle', {})}
        description={n.self ? t('remind.set.inUse.confirmBodySelf', { date }) : t('remind.set.inUse.confirmBody', { label, date })}
      >
        <div className={styles.dlgBtns}>
          <Pressable type="button" className={styles.ghost} onClick={() => setConfirm(false)} data-testid="remind-remove-cancel">
            {t('remind.set.inUse.cancel', {})}
          </Pressable>
          <Pressable
            type="button"
            className={styles.dangerFill}
            data-testid="remind-remove-confirm"
            onClick={() => {
              setConfirm(false);
              void s.removeHolder(n.holder.id);
            }}
          >
            {t('remind.set.inUse.confirmOk', {})}
          </Pressable>
        </div>
      </Dialog>
    </>
  );
}

/** 顶部提示：推送被占着（移除它）、要重新打开、不支持；移除的结果在推送接上、提示消失后也留着 */
export function NoticeCard({ s }: { s: S }) {
  const t = useRemindT();
  const msg = s.remove ? removeMsg(t, s.remove) : null;
  if (!s.notice && !msg) return null;
  return (
    <section className={styles.notice} role="status" data-testid={s.notice ? `remind-notice-${s.notice.kind}` : 'remind-notice-done'}>
      {s.notice?.kind === 'in_use' && <InUse s={s} n={s.notice} />}
      {msg && (
        <p className={s.remove === 'ok' ? styles.ok : styles.error} role="alert" data-testid="remind-remove-result">
          {msg}
        </p>
      )}
      {s.notice?.kind === 'resubscribe' && (
        <Pressable type="button" className={styles.act} onClick={() => void s.reclaim()} data-testid="remind-resubscribe">
          {t('remind.set.resubscribe', {})}
        </Pressable>
      )}
      {s.notice?.kind === 'not_supported' && <p className={styles.noticeText}>{t('remind.set.notSupported', {})}</p>}
    </section>
  );
}

