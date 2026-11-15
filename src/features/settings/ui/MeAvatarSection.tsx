// 设置 › 账号顶部的头像（R-384）：大头像（kit 的 MeAvatar size lg，和四页右上角同一套取图）+“更换头像”+“去掉头像”（有头像才有）
// • 点“更换头像”从相册选一张 → kit 的 AvatarPicker（按需加载）裁成圆 → hooks/useMeAvatarEdit 写行、上传、失败回滚
// • 没网：两个按钮置灰，下面写“没有网络，联网后才能换头像”；额度满了出 settings.avatar.quota_exceeded
// • 状态行 role="status"（读屏念得到），失败的那几句 role="alert"
import { lazy, Suspense, useRef } from 'react';
import { FormButton } from '../../../kit/components/Form.tsx';
import { MeAvatar } from '../../../kit/components/MeAvatar.tsx';
import { useHasMeAvatar } from '../../../kit/hooks/useMeAvatar.ts';
import { useOnline } from '../../../kit/hooks/useOnline.ts';
import { meAvatarEncode, meAvatarLog, type MeAvatarEdit, type MeAvatarState } from '../hooks/useMeAvatarEdit.ts';
import { useSettingsT, type SettingsMsgKey } from '../hooks/useSettingsT.ts';
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

export function MeAvatarSection({ avatar }: { avatar: MeAvatarEdit }) {
  const t = useSettingsT();
  const online = useOnline();
  const has = useHasMeAvatar();
  const input = useRef<HTMLInputElement>(null);
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
    <div className={styles.meAv} data-testid="settings-me-avatar">
      <MeAvatar size="lg" testId="settings-me-avatar-face" />
      <div className={styles.meAvSide}>
        <span className={styles.srOnly}>{t('settings.avatar.label', {})}</span>
        <div className={styles.meAvBtns}>
          <FormButton size="compact" disabled={off} onClick={() => input.current?.click()} data-testid="settings-me-avatar-change">
            {t('settings.avatar.change', {})}
          </FormButton>
          {has ? (
            <FormButton size="compact" disabled={off} onClick={() => void avatar.remove()} data-testid="settings-me-avatar-remove">
              {t('settings.avatar.remove', {})}
            </FormButton>
          ) : null}
        </div>
        <p className={msg.alert ? styles.meAvErr : styles.meAvHint} role={msg.alert ? 'alert' : 'status'} data-testid="settings-me-avatar-msg">
          {t(msg.key, {})}
        </p>
      </div>
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
