// 设置 › 已登录设备（iOS 分组表）
// 每台：名字（没起名按平台）、本机 / 已退出标记、最近使用时间（本机写“正在使用”）、“很久没用，<日期> 后自动移除”、移除按钮；
// 下面“另有 N 个登录没有设备记录（最近一次 <时间>）”（N 为 0 时不显示）和“退出其他所有设备”
// 每台前面一个手机小方块图标（本机柠檬黄），右边“退出这台设备”“移除”是正文色文字按钮（整页只有“注销账号”用危险色）；
// “退出其他所有设备”单独一组、字居中，说明小字放在这一组下面当脚注
import { useEffect, useRef, useState } from 'react';
import { fmtDate } from '../../../../shared/i18n/fmt.ts';
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import { FormButton, groupLabelClass } from '../../../kit/components/Form.tsx';
import { SettingsDetailRow, SettingsEntryRow, SettingsIcon, SettingsList, settingsNoteClass } from '../../../kit/components/Settings/Settings.tsx';
import { useUi } from '../../../kit/state/ui-store.ts';
import type { DeviceNotice, DeviceView, useDevices } from '../hooks/useDevices.ts';
import { onlineNow } from '../../../kit/hooks/useOnline.ts';
import { useSettingsT, type SettingsMsgKey } from '../hooks/useSettingsT.ts';
import { ConfirmDialog } from '../../../kit/components/ConfirmDialog.tsx';
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

/** 设备行前面的手机图标（stroke 由 kit .ico svg 统一画） */
const PHONE = (
  <svg viewBox="0 0 24 24">
    <rect x="6.5" y="2.5" width="11" height="19" rx="2.6" />
    <path d="M10.5 18.5h3" />
  </svg>
);

function DeviceRowView({ d, busy, onRemove }: { d: DeviceView; busy: boolean; onRemove(): void }) {
  const t = useSettingsT();
  const locale = useUi((s) => s.locale);
  const name = deviceName(d, t);
  // kit 的 SettingsDetailRow，前面手机图标；“移除”是正文色文字按钮（FormButton text），账号页只有“注销账号”用危险色
  return (
    <SettingsDetailRow
      testId="settings-device"
      current={d.isCurrent}
      lead={<SettingsIcon accent={d.isCurrent}>{PHONE}</SettingsIcon>}
      label={
        <>
          {name}
          {d.isCurrent ? <span className={styles.tag}>{t('settings.devices.thisDevice', {})}</span> : null}
          {d.signedOut ? <span className={`${styles.tag} ${styles.tagMuted}`}>{t('settings.devices.signedOut', {})}</span> : null}
        </>
      }
      action={
        <FormButton
          variant="text"
          disabled={busy}
          onClick={onRemove}
          // 读屏名要包含看得见的文字（WCAG 2.5.3）；整句走词典，韩文按韩语语序
          aria-label={d.isCurrent ? t('settings.devices.removeThisLabel', { name }) : t('settings.devices.removeLabel', { name })}
        >
          {d.isCurrent ? t('settings.devices.removeThis', {}) : t('settings.devices.remove', {})}
        </FormButton>
      }
      metas={[
        {
          // 本机写“正在使用”，不写 last_seen_at：它登记后每天最多刷新一次（core/device-reg.ts），写出来是上次刷新的旧时间
          text: `${
            d.isCurrent
              ? t('settings.devices.inUse', {})
              : d.lastActiveMs === null
                ? t('settings.devices.neverSeen', {})
                : t('settings.devices.lastSeen', { date: fmtWhen(d.lastActiveMs, locale) })
          }${d.autoRemoveAtMs === null ? '' : ` · ${t('settings.devices.stale', { date: fmtDate(d.autoRemoveAtMs, localTz(), locale, 'monthDay') })}`}`,
        },
      ]}
    />
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
      <h3 id="settings-devices-title" className={`${groupLabelClass} ${styles.gt}`} ref={titleRef} tabIndex={-1}>
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
          <FormButton size="compact" onClick={() => void devices.reload()}>
            {t('settings.devices.retry', {})}
          </FormButton>
        </div>
      ) : null}
      {state.kind === 'ready' ? (
        <>
          {state.list.length === 0 ? (
            <p className={styles.status}>{t('settings.devices.empty', {})}</p>
          ) : (
            <SettingsList testId="settings-devices">
              {state.list.map((d) => (
                <DeviceRowView
                  key={d.id}
                  d={d}
                  busy={busy !== null}
                  onRemove={() => (d.isCurrent ? onExitHere() : setPending({ kind: 'remove', device: d }))}
                />
              ))}
            </SettingsList>
          )}
          {state.orphans.count > 0 ? (
            <p className={`${settingsNoteClass} ${styles.foot}`} data-testid="settings-orphans">
              {t('settings.devices.orphans', {
                n: state.orphans.count,
                date: state.orphans.lastAtMs === null ? '—' : fmtWhen(state.orphans.lastAtMs, locale),
              })}
            </p>
          ) : null}
          <div className={styles.gap}>
            <SettingsList>
              <SettingsEntryRow
                label={t('settings.devices.signOutOthers', {})}
                center
                disabled={busy !== null}
                onOpen={() => setPending({ kind: 'others' })}
                testId="settings-devices-others"
              />
            </SettingsList>
          </div>
          <p className={`${settingsNoteClass} ${styles.foot}`}>{t('settings.devices.residual', {})}</p>
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
 * 设备操作失败时提示哪一句。穷尽 switch、不写 default：
 * try_later 单独一支“服务器忙，稍后再试”（临时故障，只提示、不清本机）；加了新码不补分支就编译不过
 */
export function deviceErrKey(e: DeviceErr, online: boolean = onlineNow()): Extract<SettingsMsgKey, `settings.err.${string}`> {
  switch (e) {
    case 'offline':
      return online ? 'settings.err.unreachable' : 'settings.err.offline';
    case 'try_later':
      return 'settings.err.tryLater';
    case 'account_disabled':
      return 'settings.err.accountDisabled';
    case 'revoked':
    case 'signed_out':
    case 'is_current_device':
    case 'device_not_found':
    case 'quota_exceeded':
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
