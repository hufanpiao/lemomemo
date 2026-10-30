// 设置 › 已登录设备（架构 0.29 续第 98、103、108、111 条；15.7 第 19 项）
// 每台：名字（没起名按平台）、本机 / 已退出标记、最近使用时间、“很久没用，<日期> 后自动移除”、移除按钮；
// 下面“另有 N 个登录没有设备记录（最近一次 <时间>）”（N 为 0 时不显示）和“退出其他所有设备”
import { useEffect, useRef, useState } from 'react';
import { fmtDate } from '../../../../shared/i18n/fmt.ts';
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { Pressable } from '../../../motion/components.ts';
import type { DeviceNotice, DeviceView, useDevices } from '../hooks/useDevices.ts';
import { useSettingsT, type SettingsMsgKey } from '../hooks/useSettingsT.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import styles from './SettingsPage.module.css';

type Devices = ReturnType<typeof useDevices>;
type T = ReturnType<typeof useSettingsT>;

/** 本机所在时区（只用来显示时间） */
function localTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul';
  } catch {
    return 'Asia/Seoul';
  }
}

export function fmtWhen(ms: number, locale: Locale, tz: string = localTz()): string {
  return `${fmtDate(ms, tz, locale, 'monthDay')} ${fmtDate(ms, tz, locale, 'time')}`;
}

export function deviceName(d: DeviceView, t: T): string {
  if (d.label) return d.label;
  return t(`settings.platform.${d.platform}`, {});
}

type Pending = { kind: 'remove'; device: DeviceView } | { kind: 'others' } | null;

function DeviceRowView({ d, busy, onRemove }: { d: DeviceView; busy: boolean; onRemove(): void }) {
  const t = useSettingsT();
  const locale = useUi((s) => s.locale);
  const name = deviceName(d, t);
  return (
    <li className={styles.row} data-testid="settings-device" data-current={d.isCurrent ? '1' : undefined}>
      <span className={styles.tx}>
        {name}
        {d.isCurrent ? <span className={styles.tag}>{t('settings.devices.thisDevice', {})}</span> : null}
        {d.signedOut ? <span className={`${styles.tag} ${styles.tagMuted}`}>{t('settings.devices.signedOut', {})}</span> : null}
      </span>
      <Pressable
        className={`${styles.btn} ${styles.danger}`}
        disabled={busy}
        onClick={onRemove}
        // 读屏名要包含看得见的文字（WCAG 2.5.3）
        aria-label={d.isCurrent ? `${t('settings.devices.removeThis', {})}（${name}）` : `${t('settings.devices.remove', {})} ${name}`}
      >
        {d.isCurrent ? t('settings.devices.removeThis', {}) : t('settings.devices.remove', {})}
      </Pressable>
      <p className={styles.meta}>
        {d.lastActiveMs === null
          ? t('settings.devices.neverSeen', {})
          : t('settings.devices.lastSeen', { date: fmtWhen(d.lastActiveMs, locale) })}
        {d.autoRemoveAtMs === null ? null : ` · ${t('settings.devices.stale', { date: fmtDate(d.autoRemoveAtMs, localTz(), locale, 'monthDay') })}`}
      </p>
    </li>
  );
}

/** onExitHere：本机那一行的“退出这台设备”交给页面（和“退出登录”同一个计数和确认） */
export function DevicesSection({ devices, onExitHere }: { devices: Devices; onExitHere(): void }) {
  const t = useSettingsT();
  const locale = useUi((s) => s.locale);
  const [pending, setPending] = useState<Pending>(null);
  const { state, busy, notice } = devices;
  const titleRef = useRef<HTMLHeadingElement>(null);

  // 移除一台以后那一行没了，焦点不能丢在页面开头：移到列表标题（读屏接着读到下面的“已移除…”）
  useEffect(() => {
    if (notice?.kind === 'removed' || notice?.kind === 'notFound') titleRef.current?.focus();
  }, [notice]);

  const confirm = (): void => {
    const p = pending;
    setPending(null);
    if (p?.kind === 'remove') void devices.remove(p.device);
    else if (p?.kind === 'others') void devices.signOutOthers();
  };

  const removing = pending?.kind === 'remove' ? pending.device : null;
  const pendingName = removing ? deviceName(removing, t) : '';

  return (
    <section aria-labelledby="settings-devices-title">
      <h3 id="settings-devices-title" className={styles.gt} ref={titleRef} tabIndex={-1}>
        {t('settings.devices.title', {})}
      </h3>
      {state.kind === 'loading' ? (
        <p className={styles.status} role="status">
          {t('settings.devices.loading', {})}
        </p>
      ) : null}
      {state.kind === 'error' && state.error !== 'revoked' && state.error !== 'signed_out' ? (
        <div role="alert">
          <p className={styles.error}>
            {state.error === 'account_disabled' ? t('settings.err.accountDisabled', {}) : t('settings.devices.loadFailed', {})}
          </p>
          <Pressable className={styles.btn} onClick={() => void devices.reload()}>
            {t('settings.devices.retry', {})}
          </Pressable>
        </div>
      ) : null}
      {state.kind === 'ready' ? (
        <>
          {state.list.length === 0 ? (
            <p className={styles.status}>{t('settings.devices.empty', {})}</p>
          ) : (
            <ul className={styles.grp} data-testid="settings-devices">
              {state.list.map((d) => (
                <DeviceRowView
                  key={d.id}
                  d={d}
                  busy={busy !== null}
                  onRemove={() => (d.isCurrent ? onExitHere() : setPending({ kind: 'remove', device: d }))}
                />
              ))}
            </ul>
          )}
          {state.orphans.count > 0 ? (
            <p className={styles.sn} data-testid="settings-orphans">
              {t('settings.devices.orphans', {
                n: state.orphans.count,
                date: state.orphans.lastAtMs === null ? '—' : fmtWhen(state.orphans.lastAtMs, locale),
              })}
            </p>
          ) : null}
          <Pressable className={`${styles.btn} ${styles.wide}`} disabled={busy !== null} onClick={() => setPending({ kind: 'others' })}>
            {t('settings.devices.signOutOthers', {})}
          </Pressable>
          <p className={styles.sn}>{t('settings.devices.residual', {})}</p>
        </>
      ) : null}
      <DeviceNoticeView notice={notice} />
      <ConfirmDialog
        open={pending !== null}
        danger
        title={pending?.kind === 'others' ? t('settings.confirm.others.title', {}) : t('settings.confirm.remove.title', { name: pendingName })}
        body={pending?.kind === 'others' ? t('settings.confirm.others.body', {}) : t('settings.confirm.remove.body', {})}
        okLabel={pending?.kind === 'others' ? t('settings.confirm.others.ok', {}) : t('settings.confirm.remove.ok', {})}
        cancelLabel={t('settings.cancel', {})}
        onOk={confirm}
        onCancel={() => setPending(null)}
      />
    </section>
  );
}

type DeviceErr = Extract<DeviceNotice, { kind: 'error' }>['error'];

/**
 * 设备操作失败时提示哪一句。穷尽 switch、不写 default（R272-sugg ④，架构 0.29 续第 119 条②）：
 * try_later 单独一支“服务器忙，稍后再试”（临时故障，只提示、不清本机）；加了新码不补分支就编译不过
 */
export function deviceErrKey(e: DeviceErr): Extract<SettingsMsgKey, `settings.err.${string}`> {
  switch (e) {
    case 'offline':
      return 'settings.err.offline';
    case 'try_later':
      return 'settings.err.tryLater';
    case 'account_disabled':
      return 'settings.err.accountDisabled';
    case 'revoked':
    case 'signed_out':
    case 'is_current_device':
    case 'device_not_found':
    case 'unknown':
      return 'settings.err.unknown';
  }
}

function DeviceNoticeView({ notice }: { notice: Devices['notice'] }) {
  const t = useSettingsT();
  if (!notice) return null;
  if (notice.kind === 'error') {
    return (
      <p className={styles.error} role="alert">
        {t(deviceErrKey(notice.error), {})}
      </p>
    );
  }
  if (notice.kind === 'isCurrent') {
    return (
      <p className={styles.error} role="alert">
        {t('settings.devices.isCurrent', {})}
      </p>
    );
  }
  const text =
    notice.kind === 'removed'
      ? t('settings.devices.removed', { name: deviceName(notice.device, t) })
      : notice.kind === 'notFound'
        ? t('settings.devices.notFound', {})
        : t('settings.devices.signOutOthersDone', {});
  return (
    <p className={styles.status} role="status">
      {text}
    </p>
  );
}
