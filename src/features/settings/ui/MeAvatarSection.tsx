// 设置 › 账号顶部的头像：大头像（kit 的 MeAvatar size lg，和四页右上角同一套取图）+“更换头像”+“去掉头像”（有头像才有）
// 这些装进一组（kit SettingsList，iOS 分组表）——第一行头像、当前登录邮箱和说明，
// 下面“更换头像”（柠檬黄图标、带 ›）、“去掉头像”（灰图标、不带 ›）两行整行可点。
// 两行禁用时（没网、正在换）aria-describedby 指向下面那句说明（“没有网络，联网后才能换头像”等），读屏知道为什么点不了
// • 点“更换头像”从相册选一张 → kit 的 AvatarPicker（按需加载）裁成圆 → hooks/useMeAvatarEdit 写行、上传、失败回滚
// • 没网：两个按钮置灰，下面写“没有网络，联网后才能换头像”；额度满了出 settings.avatar.quota_exceeded
// • 状态行 role="status"（读屏念得到），失败的那几句 role="alert"
import { lazy, Suspense, useId, useRef } from 'react';
import { MeAvatar } from '../../../kit/components/MeAvatar.tsx';
import { settingsErrorClass, SettingsEntryRow, SettingsIcon, SettingsList, settingsMetaClass, SettingsRow } from '../../../kit/components/Settings/Settings.tsx';
import { useHasMeAvatar } from '../../../kit/hooks/useMeAvatar.ts';
import { useOnline } from '../../../kit/hooks/useOnline.ts';
import { meAvatarEncode, meAvatarLog, type MeAvatarEdit, type MeAvatarState } from '../hooks/useMeAvatarEdit.ts';
import { useSettingsT, type SettingsMsgKey } from '../hooks/useSettingsT.ts';
import { MailLabel } from './MailLabel.tsx';
import styles from './SettingsPage.module.css';

const AvatarPicker = lazy(() => import('../../../kit/components/AvatarPicker.tsx'));

type AvKey = Extract<SettingsMsgKey, `settings.avatar.${string}`>;

const STATE_KEY: Readonly<Record<Exclude<MeAvatarState, 'idle'>, AvKey>> = {
  busy: 'settings.avatar.busy',
  encode_failed: 'settings.avatar.encode_failed',
  write_failed: 'settings.avatar.write_failed',
  upload_failed: 'settings.avatar.upload_failed',
  quota_exceeded: 'settings.avatar.quota_exceeded',
  offline: 'settings.avatar.offline',
};

/** 图标（stroke 由 kit .ico svg 统一画） */
const CAMERA = (
  <svg viewBox="0 0 24 24">
    <path d="M4 8h3l2-2.5h6L17 8h3v11H4z" />
    <circle cx="12" cy="13" r="3.4" />
  </svg>
);
const MINUS = (
  <svg viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="8" />
    <path d="M8.5 12h7" />
  </svg>
);

/** email：当前登录邮箱；null 时这一行不出 */
export function MeAvatarSection({ avatar, email }: { avatar: MeAvatarEdit; email: string | null }) {
  const t = useSettingsT();
  const online = useOnline();
  const has = useHasMeAvatar();
  const input = useRef<HTMLInputElement>(null);
  const msgId = useId();
  const busy = avatar.state === 'busy' || avatar.file !== null;
  const off = !online || busy;
  const msg: { key: AvKey; alert: boolean } =
    !online && !busy ? { key: 'settings.avatar.offline', alert: false }
      : avatar.state === 'idle' ? { key: 'settings.avatar.hint', alert: false }
        : { key: STATE_KEY[avatar.state], alert: avatar.state !== 'busy' };
  const text = {
    title: t('settings.avatar.crop.title', {}),
    hint: t('settings.avatar.crop.hint', {}),
    area: t('settings.avatar.crop.area', {}),
    zoom: t('settings.avatar.crop.zoom', {}),
    ok: t('settings.avatar.crop.ok', {}),
    cancel: t('settings.avatar.crop.cancel', {}),
  };
  return (
    <div data-testid="settings-me-avatar">
      <SettingsList>
        <SettingsRow>
          <div className={styles.meAv}>
            <MeAvatar size="lg" testId="settings-me-avatar-face" />
            <div className={styles.meAvSide}>
              <span className={styles.srOnly}>{t('settings.avatar.label', {})}</span>
              {email ? (
                <p className={styles.email} data-testid="settings-account-email">
                  <span className={styles.srOnly}>{t('settings.account.email', {})}</span>
                  <MailLabel mail={email} />
                </p>
              ) : null}
              <p id={msgId} className={msg.alert ? settingsErrorClass : settingsMetaClass} role={msg.alert ? 'alert' : 'status'} data-testid="settings-me-avatar-msg">
                {t(msg.key, {})}
              </p>
            </div>
          </div>
        </SettingsRow>
        <SettingsEntryRow
          lead={<SettingsIcon accent>{CAMERA}</SettingsIcon>}
          label={t('settings.avatar.change', {})}
          disabled={off}
          describedBy={off ? msgId : undefined}
          onOpen={() => input.current?.click()}
          testId="settings-me-avatar-change"
        />
        {has ? (
          <SettingsEntryRow
            lead={<SettingsIcon>{MINUS}</SettingsIcon>}
            label={t('settings.avatar.remove', {})}
            chev={false}
            disabled={off}
            describedBy={off ? msgId : undefined}
            onOpen={() => void avatar.remove()}
            testId="settings-me-avatar-remove"
          />
        ) : null}
      </SettingsList>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          avatar.pick(e.target.files?.[0] ?? null);
          e.target.value = '';
        }}
        data-testid="settings-me-avatar-file"
      />
      {avatar.file ? (
        <Suspense fallback={null}>
          <AvatarPicker file={avatar.file} onDone={(b) => void avatar.done(b)} onCancel={avatar.cancel} encode={meAvatarEncode} text={text} log={meAvatarLog} testId="settings-me-avatar" />
        </Suspense>
      ) : null}
    </div>
  );
}
