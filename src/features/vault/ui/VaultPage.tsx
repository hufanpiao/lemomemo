// 隐私记页面（B5 S5、S6、S9；定稿线框 s9 PRIVLIST；代定 D14）：#/vault（列表）、#/vault/new、#/vault/<id>（编辑）、#/vault/trash（自己的“最近删除”）
// • 状态：查状态中 → 断网（要联网才能打开，TC-B5-33）/ 没设过密码（设密码）/ 锁着（磨砂遮罩 + 解锁卡）/ 已解锁（内容）
// • 已解锁：顶栏“‹ 随手记 | 🔒 隐私记 | 立即锁上”，下面一条“已解锁 · 离开 App 1 分钟自动锁上…”；Ctrl+L 立即上锁
// • 底栏照常（随手记页签），“＋”只打开隐私记的新建页（D14：往 kit/state/new-item.ts 的 notesInput 登记）
// • 不建液态玻璃副本、底栏和“＋”实色：挂着时经 platform/look.ts 的 holdReducedTransparency 让 <html data-rt="1">（同“减少透明效果”，
//   motion/glass-ghost.ts 和 GlassBar 都认它），离开时放开、按设置和系统设置重算（TC-B5-12；hooks/useVault.ts 的 useSolidBars）
// • 多任务遮罩 LockShield 一直挂在页面上（平时 visibility: hidden），离开时由 hooks/useVault.ts 同步盖上
import { useLayoutEffect, useState } from 'react';
import { backTo, navigate, useRoute } from '../../../app/router.ts';
import { ConfirmDialog } from '../../../kit/components/ConfirmDialog.tsx';
import { FormButton } from '../../../kit/components/Form.tsx';
import { BackLink } from '../../../kit/components/BackLink.tsx';
import { useKeys } from '../../../kit/hooks/useKeys.ts';
import { notesInput } from '../../../kit/state/new-item.ts';
import { useAutolockMin, useErrText, useSolidBars, useVault, useVaultStatus } from '../hooks/useVault.ts';
import { useVaultT } from '../hooks/useVaultT.ts';
import { LockIcon } from './Pin.tsx';
import { SetupPin } from './SetupPin.tsx';
import { UnlockOverlay, UnlockPanel } from './Unlock.tsx';
import { VaultEditor } from './VaultEditor.tsx';
import styles from './Vault.module.css';

/** 只有 Lemo 图标的实色遮罩（S6、TC-B5-44） */
export function LockShield() {
  return (
    <div className={styles.shield} data-testid="vault-shield" aria-hidden="true">
      <img className={styles.shieldLogo} src="/app/icons/logo-mark-small.svg" alt="" width={96} height={96} />
    </div>
  );
}

export default function VaultPage() {
  const t = useVaultT();
  const state = useVaultStatus();
  const { s } = useVault();
  const errText = useErrText();
  const [sub = ''] = useRoute().params;
  useSolidBars();
  useAutolockMin();
  useKeys({
    'mod+l': () => {
      s.lock();
      return true;
    },
  });
  useLayoutEffect(() => {
    notesInput.focus = () => void navigate('vault', 'new');
    return () => {
      notesInput.focus = undefined;
    };
  }, []);

  const leave = () => backTo('notes');
  const forgot = () => void navigate('settings', 'vault', 'reset');
  const unlocked = state.phase === 'unlocked' && !state.waiting;
  let body;
  if (state.phase === 'loading') body = <p className={styles.empty}>{t('vault.loading', {})}</p>;
  else if (state.phase === 'offline' || state.phase === 'error')
    body = (
      <div className={styles.flow} data-testid="vault-offline">
        <p className={styles.notice} role="alert">
          {state.phase === 'offline' ? t('vault.offline', {}) : errText(state.lastError)}
        </p>
        <FormButton onClick={() => void s.refreshStatus()} data-testid="vault-retry">
          {t('vault.retry', {})}
        </FormButton>
      </div>
    );
  else if (state.phase === 'unset') body = <SetupPin onCancel={leave} />;
  else if (unlocked) body = sub === 'trash' ? <VaultTrash /> : sub ? <VaultEditor key={sub} id={sub === 'new' ? null : sub} /> : <VaultList />;
  else body = null;

  return (
    <main className={styles.page} data-feature="vault" data-testid="vault" data-phase={state.phase}>
      {state.phase !== 'unset' && !(unlocked && sub) ? (
        <header className={styles.top}>
          <BackLink label={t('vault.back', {})} onBack={leave} testId="vault-back" />
          <h1 className={styles.h1}>
            <LockIcon />
            {t('vault.title', {})}
          </h1>
          <span className={styles.topEnd}>
            {unlocked ? (
              <FormButton size="compact" onClick={() => s.lock()} data-testid="vault-lock-now">
                {t('vault.lockNow', {})}
              </FormButton>
            ) : null}
          </span>
        </header>
      ) : null}
      {body}
      <UnlockOverlay open={state.phase === 'locked' || state.waiting}>
        <UnlockPanel onCancel={leave} onForgot={forgot} />
      </UnlockOverlay>
      <LockShield />
    </main>
  );
}

function VaultList() {
  const t = useVaultT();
  const { state } = useVault();
  const min = useAutolockMin();
  const notes = (state.notes ?? []).filter((n) => n.deleted_at === null).sort((a, b) => b.updated_at - a.updated_at);
  const trash = (state.notes ?? []).filter((n) => n.deleted_at !== null).length;
  return (
    <>
      <p className={styles.hint} data-testid="vault-hint">
        {t('vault.unlockedHint', { n: min })}
      </p>
      {notes.length === 0 ? (
        <p className={styles.empty} data-testid="vault-empty">
          {t('vault.empty', {})}
        </p>
      ) : (
        <ul className={styles.lst} data-testid="vault-list">
          {notes.map((n) => (
            <li key={n.id} className={styles.row} data-testid={`vault-row-${n.id}`}>
              <button type="button" className={styles.rowMain} onClick={() => void navigate('vault', n.id)}>
                <span className={styles.rowTitle}>{n.title || n.body.split('\n')[0] || t('vault.list.untitled', {})}</span>
                <span className={styles.rowSub}>
                  {n.title ? n.body.split('\n')[0] : ''}
                  {n.images.filter((i) => i.deleted_at === null).length ? ` · ${t('vault.list.images', { n: n.images.filter((i) => i.deleted_at === null).length })}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.trashLink}>
        <FormButton variant="ghost" onClick={() => void navigate('vault', 'trash')} data-testid="vault-open-trash">
          {`${t('vault.trash', {})}${trash ? ` ${trash}` : ''}`}
        </FormButton>
      </div>
    </>
  );
}

function VaultTrash() {
  const t = useVaultT();
  const { state, s } = useVault();
  const errText = useErrText();
  const [ask, setAsk] = useState<string[] | null>(null);
  const [err, setErr] = useState('');
  const gone = (state.notes ?? []).filter((n) => n.deleted_at !== null);
  const run = async (go: () => Promise<{ ok: boolean; code?: Parameters<typeof errText>[0] }>) => {
    setErr('');
    const r = await go();
    if (!r.ok) setErr(errText(r.code ?? 'unknown'));
  };
  return (
    <section data-testid="vault-trash">
      <div className={styles.top}>
        <BackLink label={t('vault.title', {})} onBack={() => void navigate('vault')} testId="vault-trash-back" />
        <h2 className={styles.h1}>{t('vault.trash', {})}</h2>
        <span className={styles.topEnd}>
          {gone.length ? (
            <FormButton size="compact" danger onClick={() => setAsk(gone.map((n) => n.id))} data-testid="vault-purge-all">
              {t('vault.purgeAll', {})}
            </FormButton>
          ) : null}
        </span>
      </div>
      <p className={styles.hint}>{t('vault.trash.hint', {})}</p>
      {err ? (
        <p className={styles.notice} role="alert">
          {err}
        </p>
      ) : null}
      {gone.length === 0 ? (
        <p className={styles.empty}>{t('vault.trash.empty', {})}</p>
      ) : (
        <ul className={styles.lst}>
          {gone.map((n) => (
            <li key={n.id} className={styles.row} data-testid={`vault-trash-row-${n.id}`}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{n.title || n.body.split('\n')[0] || t('vault.list.untitled', {})}</span>
              </span>
              <span className={styles.rowActs}>
                <FormButton size="compact" onClick={() => void run(() => s.undelete(n.id))} data-testid={`vault-restore-${n.id}`}>
                  {t('vault.restore', {})}
                </FormButton>
                <FormButton size="compact" danger onClick={() => setAsk([n.id])} data-testid={`vault-purge-${n.id}`}>
                  {t('vault.purge', {})}
                </FormButton>
              </span>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={ask !== null}
        title={ask && ask.length > 1 ? t('vault.purgeAll.title', {}) : t('vault.purge.title', {})}
        body={ask && ask.length > 1 ? t('vault.purgeAll.body', { n: ask.length }) : t('vault.purge.body', {})}
        okLabel={t('vault.purge', {})}
        cancelLabel={t('vault.cancel', {})}
        danger
        testId="vault-purge-confirm"
        onOk={() => {
          const items = ask ?? [];
          setAsk(null);
          void run(() => s.purge(items));
        }}
        onCancel={() => setAsk(null)}
      />
    </section>
  );
}
