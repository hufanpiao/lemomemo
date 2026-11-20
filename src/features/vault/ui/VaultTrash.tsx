// 隐私记自己的“最近删除”（B5 S9；#/vault/trash）：只有隐私记的内容，不进随手记的最近删除
// • 读会话的内存仓库（data/vault-store.ts）里删了的那些；恢复走会话的 setDeleted（列表、编辑器经来源也走它，界面立刻变）
// • 永久删除要确认，直接发 vault {purge}（不进队列：确认过的动作，等它回来再出结果）；成了会话从仓库拿掉
// • VaultPage 等列表拉到了才画这一页（不先闪一下“没有删除的内容”）
// • 2026-11-15 从 VaultPage.tsx 拆出来（隐私记重写：列表、编辑器换成随手记那一份，这一块留着）
import { useState } from 'react';
import { navigate } from '../../../app/router.ts';
import { ConfirmDialog } from '../../../kit/components/ConfirmDialog.tsx';
import { FormButton } from '../../../kit/components/Form.tsx';
import row from '../../../kit/components/NoteRow.module.css';
import { str, useErrText, useVault, useVaultStore } from '../hooks/useVault.ts';
import { useVaultT } from '../hooks/useVaultT.ts';
import { VaultTop } from './Pin.tsx';
import styles from './Vault.module.css';

export function VaultTrash() {
  const t = useVaultT();
  const { s } = useVault();
  const errText = useErrText();
  const snap = useVaultStore();
  const [ask, setAsk] = useState<string[] | null>(null);
  const [err, setErr] = useState('');
  const gone = snap.notes.filter((n) => n['deleted_at'] !== null);
  const restore = (id: string): void => void s.setDeleted(id, false);
  const purge = async (items: string[]): Promise<void> => {
    setErr('');
    const r = await s.purge(items);
    if (!r.ok) setErr(errText(r.code));
  };
  return (
    <section data-testid="vault-trash">
      <VaultTop
        back={{ label: t('vault.title', {}), onBack: () => void navigate('vault'), testId: 'vault-trash-back' }}
        title={t('vault.trash', {})}
        level={2}
        end={
          <span className={styles.topEnd}>
            {gone.length ? (
              <FormButton size="compact" danger onClick={() => setAsk(gone.map((n) => n.id))} data-testid="vault-purge-all">
                {t('vault.purgeAll', {})}
              </FormButton>
            ) : null}
          </span>
        }
      />
      <p className={styles.hint}>{t('vault.trash.hint', {})}</p>
      {err ? (
        <p className={styles.notice} role="alert">
          {err}
        </p>
      ) : null}
      {gone.length === 0 ? (
        <p className={styles.empty}>{t('vault.trash.empty', {})}</p>
      ) : (
        <ul className={row.lst}>
          {gone.map((n) => (
            <li key={n.id} className={styles.row} data-testid={`vault-trash-row-${n.id}`}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{str(n['title']) || str(n['body']).split('\n')[0] || t('vault.trash.untitled', {})}</span>
              </span>
              <span className={styles.rowActs}>
                <FormButton size="compact" onClick={() => restore(n.id)} data-testid={`vault-restore-${n.id}`}>
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
          void purge(items);
        }}
        onCancel={() => setAsk(null)}
      />
    </section>
  );
}
