// 隐私记给别的功能用的几块（经 vault/index.ts 的一个懒加载导出 VaultParts 分发，首屏只多一个 lazy，B5 首屏额度）
// • lockrow：随手记列表顶部的入口行（线框 s7 LOCKROW）：“🔒 隐私记 已上锁 · 6 条 … Face ID 解锁 ›”，点了进 #/vault
// • move：把一条普通随手记移进隐私记（S7）：没设密码先去设；锁着就弹解锁卡，解锁后自动重试一次（TC-B5-47 ①）；
//   带附件回 has_files → “带附件的随手记暂时不能移进隐私记”（D13）；结果回 onDone(true / false)
// • settings：设置 › 隐私记（VaultSettings.tsx）
// • findrow（B4b-3，线框 s12、sFind）：查找面板、结果层里的一行“隐私记锁着，里面的不在结果里 · 打开隐私记 ›”；没设过隐私记密码的不出。
//   主页面的查找不查隐私记（D-16），隐私记里的查找要 VAULT_KEY，这一批不做，所以只给入口、不写“解锁后一起找”
import { useEffect, useRef, useState } from 'react';
import { navigate } from '../../../app/router.ts';
import { ConfirmDialog } from '../../../kit/components/ConfirmDialog.tsx';
import { useErrText, useVault, useVaultCount, type VaultCode } from '../hooks/useVault.ts';
import { useWebauthn } from '../hooks/useVaultAuth.ts';
import { useVaultT } from '../hooks/useVaultT.ts';
import { LockIcon } from './Pin.tsx';
import { UnlockOverlay, UnlockPanel } from './Unlock.tsx';
import { VaultSettings } from './VaultSettings.tsx';
import styles from './Vault.module.css';

export type VaultPartsProps = { part: 'lockrow' } | { part: 'findrow'; onGo?(): void } | { part: 'move'; noteId: string; onDone(moved: boolean): void } | { part: 'settings' };

export default function VaultParts(p: VaultPartsProps) {
  if (p.part === 'lockrow') return <LockRow />;
  if (p.part === 'findrow') return <FindRow onGo={p.onGo} />;
  if (p.part === 'move') return <MoveToVault noteId={p.noteId} onDone={p.onDone} />;
  return <VaultSettings />;
}

/** onGo：跳去隐私记前先关掉查找面板（面板是模态框，不关会盖在隐私记页上） */
function FindRow({ onGo }: { onGo?: (() => void) | undefined }) {
  const t = useVaultT();
  const { state, s } = useVault();
  useEffect(() => {
    if (state.status === null && state.phase === 'loading') void s.refreshStatus();
  }, [s, state.status, state.phase]);
  if (state.status?.set !== true) return null;
  return (
    <button type="button" className={`${styles.lockrow} ${styles.findrow}`} onClick={() => {
      onGo?.();
      void navigate('vault');
    }} data-testid="vault-findrow">
      <LockIcon />
      <span className={styles.lockrowSub}>{t(state.phase === 'unlocked' ? 'vault.findrow.open' : 'vault.findrow.locked', {})}</span>
      <span className={styles.lockrowGo}>{`${t('vault.findrow.go', {})} ›`}</span>
    </button>
  );
}

function LockRow() {
  const t = useVaultT();
  const { state, s } = useVault();
  const wa = useWebauthn();
  const count = useVaultCount();
  useEffect(() => {
    if (state.status === null && state.phase === 'loading') void s.refreshStatus();
  }, [s, state.status, state.phase]);
  const method = t(wa.method === 'faceid' ? 'vault.method.faceid' : 'vault.method.hello', {});
  const unset = state.status?.set === false;
  const unlocked = state.phase === 'unlocked';
  const sub = unset ? '' : unlocked ? t('vault.lockrow.unlocked', { n: count }) : count ? t('vault.lockrow.locked', { n: count }) : t('vault.lockrow.lockedNone', {});
  const go = unset
    ? t('vault.lockrow.setup', {})
    : unlocked
      ? t('vault.lockrow.open', {})
      : wa.usable && (state.status?.webauthn ?? 0) > 0 && !state.relocked
        ? t('vault.lockrow.with', { method })
        : t('vault.lockrow.pin', {});
  return (
    <button type="button" className={styles.lockrow} onClick={() => void navigate('vault')} data-testid="vault-lockrow">
      <LockIcon />
      <b>{t('vault.title', {})}</b>
      <span className={styles.lockrowSub}>{sub}</span>
      <span className={styles.lockrowGo}>{`${go} ›`}</span>
    </button>
  );
}

function MoveToVault({ noteId, onDone }: { noteId: string; onDone(moved: boolean): void }) {
  const t = useVaultT();
  const errText = useErrText();
  const { state, s } = useVault();
  const [err, setErr] = useState<VaultCode | 'unset' | null>(null);
  const started = useRef(false);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      let st = s.get().status;
      if (!st) {
        const r = await s.refreshStatus();
        if (!r.ok) {
          setErr(r.code);
          return;
        }
        st = r.value;
      }
      if (!st.set) {
        setErr('unset');
        return;
      }
      const r = await s.importNote(noteId);
      if (r.ok) done.current(true);
      else if (r.code === 'vault_locked') done.current(false);   // 取消了解锁
      else setErr(r.code);
    })();
  }, [s, noteId]);

  return (
    <>
      <UnlockOverlay open={state.waiting} testId="vault-move-scrim">
        <UnlockPanel onCancel={() => s.cancelWait()} onForgot={() => void navigate('settings', 'vault', 'reset')} testId="vault-move-unlock" />
      </UnlockOverlay>
      <ConfirmDialog
        open={err !== null}
        title={t('vault.move', {})}
        body={err === 'unset' ? t('vault.err.notSet', {}) : errText(err)}
        okLabel={err === 'unset' ? t('vault.lockrow.setup', {}) : t('vault.ok', {})}
        cancelLabel={t('vault.cancel', {})}
        testId="vault-move-err"
        onOk={() => {
          if (err === 'unset') void navigate('vault');
          done.current(false);
        }}
        onCancel={() => done.current(false)}
      />
    </>
  );
}
