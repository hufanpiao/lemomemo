// 设置 › 隐私记（B5 S11；线框 s13 SETDETAIL：“用 Face ID 解锁 [开关] / 自动上锁 离开 1 分钟 › / 修改密码 › / 忘记密码 用登录邮箱重设 ›”）
// • 没设过密码：只有“设个密码”一行（进 #/vault 设）
// • Face ID / Windows Hello：这台设备用不了（exe、不支持）时这一行不出现；打开 = 当场输一次密码绑定（S4）；已绑定的设备单独一页，可移除
// • 自动上锁时长写本机 settings 的 vault.autolock_min（1 / 5 / 15 分钟，默认 1；R-86）
// • 修改密码：输现在的密码 → 新密码两次 → vault {change_pin}（要令牌，锁着先解锁）
// • 忘记密码：走 S3（ResetFlow.tsx）；#/settings/vault/reset 直接打开这一步（解锁卡的“忘记密码？”）
// • 上次重设时间（last_reset_at）
import { useEffect, useState } from 'react';
import { navigate, useRoute } from '../../../app/router.ts';
import { ConfirmDialog } from '../../../kit/components/ConfirmDialog.tsx';
import { SettingsCard, SettingsEntryRow, SettingsInfoRow, SettingsSwitchRow } from '../../../kit/components/Settings/Settings.tsx';
import { SettingsChoiceCard } from '../../../kit/components/Settings/SettingsRows.tsx';
import { useSettingWriter } from '../../../kit/hooks/useSettingWriter.ts';
import { AUTOLOCK_CHOICES, AUTOLOCK_KEY, useAutolockMin, useErrText, useFmtAt, useVault, useVaultStatus } from '../hooks/useVault.ts';
import { useWebauthn } from '../hooks/useVaultAuth.ts';
import { useVaultT } from '../hooks/useVaultT.ts';
import { PinPad } from './Pin.tsx';
import { ResetFlow } from './ResetFlow.tsx';
import { NewPinSteps } from './SetupPin.tsx';
import { UnlockOverlay, UnlockPanel } from './Unlock.tsx';
import styles from './Vault.module.css';

type View = 'main' | 'autolock' | 'change' | 'reset' | 'bind' | 'devices';

export function VaultSettings() {
  const t = useVaultT();
  const state = useVaultStatus();
  const { s } = useVault();
  const wa = useWebauthn();
  const min = useAutolockMin();
  const fmtAt = useFmtAt();
  const [view, setView] = useState<View>(useRoute().params[1] === 'reset' ? 'reset' : 'main');
  const method = t(wa.method === 'faceid' ? 'vault.method.faceid' : 'vault.method.hello', {});
  const back = () => setView('main');

  const waiting = (
    <UnlockOverlay open={state.waiting} testId="vault-set-scrim">
      <UnlockPanel onCancel={() => s.cancelWait()} onForgot={() => setView('reset')} testId="vault-set-unlock" backLabel={t('vault.title', {})} />
    </UnlockOverlay>
  );

  if (view === 'reset') return <ResetFlow onDone={back} />;
  if (state.status === null) return <p className={styles.empty}>{state.phase === 'offline' ? t('vault.offline', {}) : t('vault.loading', {})}</p>;
  if (!state.status.set)
    return (
      <SettingsCard title={t('vault.title', {})} note={t('vault.set.setupSub', {})} testId="vault-settings">
        <SettingsEntryRow label={t('vault.set.setup', {})} onOpen={() => void navigate('vault')} testId="vault-set-setup" />
      </SettingsCard>
    );
  if (view === 'autolock') return <Autolock onDone={back} />;
  if (view === 'change')
    return (
      <>
        <ChangePin onDone={back} />
        {waiting}
      </>
    );
  if (view === 'bind')
    return (
      <>
        <BindFace method={method} onDone={back} />
        {waiting}
      </>
    );
  if (view === 'devices')
    return (
      <>
        <Devices method={method} onDone={back} />
        {waiting}
      </>
    );

  const last = state.status.lastResetAt;
  return (
    <SettingsCard title={t('vault.title', {})} testId="vault-settings">
      {wa.usable ? (
        <SettingsSwitchRow
          label={t('vault.set.faceid', { method })}
          checked={state.status.webauthn > 0}
          onChange={(v) => setView(v ? 'bind' : 'devices')}
          testId="vault-set-face"
        />
      ) : null}
      {state.status.webauthn > 0 ? (
        <SettingsEntryRow label={t('vault.set.devices', {})} value={String(state.status.webauthn)} onOpen={() => setView('devices')} testId="vault-set-devices" />
      ) : null}
      <SettingsEntryRow label={t('vault.set.autolock', {})} value={t('vault.set.autolockVal', { n: min })} onOpen={() => setView('autolock')} testId="vault-set-autolock" />
      <SettingsEntryRow label={t('vault.set.change', {})} onOpen={() => setView('change')} testId="vault-set-change" />
      <SettingsEntryRow label={t('vault.set.forgot', {})} value={t('vault.set.forgotSub', {})} onOpen={() => setView('reset')} testId="vault-set-forgot" />
      <SettingsInfoRow
        label={t('vault.set.lastReset', {})}
        value={last ? fmtAt(last) : t('vault.set.never', {})}
        testId="vault-set-last-reset"
      />
    </SettingsCard>
  );
}

function Autolock({ onDone }: { onDone(): void }) {
  const t = useVaultT();
  const min = useAutolockMin();
  const { save } = useSettingWriter();
  return (
    <SettingsChoiceCard
      title={t('vault.set.autolock', {})}
      showTitle
      name="vault-autolock"
      options={AUTOLOCK_CHOICES.map((n) => ({ value: String(n), label: t('vault.min', { n }), testId: `vault-autolock-${n}` }))}
      value={String(min)}
      onPick={(v) => {
        void save(AUTOLOCK_KEY, Number(v));
        onDone();
      }}
      testId="vault-autolock"
    />
  );
}

function ChangePin({ onDone }: { onDone(): void }) {
  const t = useVaultT();
  const errText = useErrText();
  const { s } = useVault();
  const [old, setOld] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(false);
  if (ok)
    return (
      <div className={styles.flow} data-testid="vault-change-done">
        <p className={styles.notice} role="status">
          {t('vault.change.done', {})}
        </p>
        <button type="button" className={styles.link} onClick={onDone}>
          {t('vault.ok', {})}
        </button>
      </div>
    );
  if (old === null)
    return (
      <div className={styles.pin} data-testid="vault-change-old">
        <h2 className={styles.pinTitle}>{t('vault.change.old', {})}</h2>
        <PinPad onSubmit={setOld} testId="vault-change-old-pad" msg={err} msgTestId="vault-change-old-err" />
      </div>
    );
  return (
    <NewPinSteps
      title={t('vault.change.new', {})}
      sub=""
      busy={busy}
      error={err}
      testId="vault-change-new"
      onDone={(p) => {
        setBusy(true);
        void s.changePin(old, p).then((r) => {
          setBusy(false);
          if (r.ok) setOk(true);
          else {
            // 读这次响应里的 left（不读 state.left：回调里的 state 是点下去那次渲染的快照）
            setErr(r.code === 'pin_wrong' && r.left !== undefined ? t('vault.unlock.left', { n: r.left }) : errText(r.code));
            setOld(null);
          }
        });
      }}
    />
  );
}

function BindFace({ method, onDone }: { method: string; onDone(): void }) {
  const t = useVaultT();
  const errText = useErrText();
  const wa = useWebauthn();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <div className={styles.pin} data-testid="vault-bind">
      <h2 className={styles.pinTitle}>{t('vault.set.bindPin', { method })}</h2>
      <PinPad
        disabled={busy}
        testId="vault-bind-pad"
        msg={err}
        msgTestId="vault-bind-err"
        onSubmit={(pin) => {
          setBusy(true);
          setErr('');
          void wa.register(pin, method).then((r) => {
            setBusy(false);
            if (r?.ok) onDone();
            else setErr(r ? errText(r.code) : t('vault.set.bindFail', {}));
          });
        }}
      />
    </div>
  );
}

function Devices({ method, onDone }: { method: string; onDone(): void }) {
  const t = useVaultT();
  const errText = useErrText();
  const { s } = useVault();
  const [items, setItems] = useState<readonly { id: string; label: string | null }[] | null>(null);
  const [ask, setAsk] = useState<string | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    void s.listCredentials().then((r) => (r.ok ? setItems(r.value.items) : setErr(errText(r.code))));
    // 只在打开时取一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s]);
  return (
    <SettingsCard title={t('vault.set.devices', {})} showTitle testId="vault-devices">
      {err ? <SettingsInfoRow label={err} value="" /> : null}
      <ul className={styles.devices}>
        {(items ?? []).map((c) => (
          <li key={c.id} className={styles.device} data-testid={`vault-device-${c.id}`}>
            <span>{c.label || t('vault.set.device', {})}</span>
            <button type="button" className={styles.link} onClick={() => setAsk(c.id)} data-testid={`vault-device-remove-${c.id}`}>
              {t('vault.set.remove', {})}
            </button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={ask !== null}
        title={t('vault.set.removeTitle', { method })}
        body={t('vault.set.removeBody', {})}
        okLabel={t('vault.set.remove', {})}
        cancelLabel={t('vault.cancel', {})}
        danger
        testId="vault-device-remove-confirm"
        onOk={() => {
          const id = ask;
          setAsk(null);
          if (id)
            void s.removeCredential(id).then((r) => {
              if (!r.ok) setErr(errText(r.code));
              else {
                const rest = (items ?? []).filter((c) => c.id !== id);
                setItems(rest);
                if (rest.length === 0) onDone();
              }
            });
        }}
        onCancel={() => setAsk(null)}
      />
    </SettingsCard>
  );
}
