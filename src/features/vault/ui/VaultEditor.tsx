// 隐私记编辑页（B5 S5、S8）：#/vault/new、#/vault/<id>。外观照随手记编辑器（线框 s8：大标题、正文、插图），顶栏“‹ 隐私记 · 保存状态”
// • 点“保存”才写（不自动保存：明文不进本机 outbox）；新建保存后留在这一页，地址换成这一条的 id
// • 插图：选照片 → 本机重新编码 → 上传；已有的图经 vault-image 取字节做成 blob: 地址（只经 kit 的 useBlobSrc 写进 <img>，A26）
// • 底部：删除（进隐私记的“最近删除”）、移出隐私记（回到普通随手记）
import { useEffect, useRef, useState } from 'react';
import { navigate, replaceRoute } from '../../../app/router.ts';
import { FormButton } from '../../../kit/components/Form.tsx';
import { BackLink } from '../../../kit/components/BackLink.tsx';
import { useBlobSrc } from '../../../kit/hooks/useBlobSrc.ts';
import { VAULT_BODY_MAX, VAULT_TITLE_MAX } from '../../../../shared/schema/vault.ts';
import { useErrText, useVault } from '../hooks/useVault.ts';
import { useVaultEdit, useVaultImage } from '../hooks/useVaultEdit.ts';
import { useVaultT } from '../hooks/useVaultT.ts';
import styles from './Vault.module.css';

function BlobImg({ url, alt }: { url: string; alt: string }) {
  const ref = useBlobSrc(url);
  return <img ref={ref} alt={alt} />;
}

function SavedImage({ id, onRemove }: { id: string; onRemove(): void }) {
  const t = useVaultT();
  const url = useVaultImage(id, 'thumb');
  return (
    <div className={styles.img} data-testid={`vault-img-${id}`}>
      {url ? <BlobImg url={url} alt={t('vault.edit.image', {})} /> : null}
      <button type="button" className={styles.imgDel} aria-label={t('vault.edit.removeImage', {})} onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

export function VaultEditor({ id }: { id: string | null }) {
  const t = useVaultT();
  const errText = useErrText();
  const { s } = useVault();
  const e = useVaultEdit(id);
  const file = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState('');
  const missing = id !== null && e.note === null;

  const save = async (): Promise<void> => {
    setStatus(t('vault.edit.saving', {}));
    const ok = await e.save();
    setStatus(ok ? t('vault.edit.saved', {}) : '');
  };
  const savedId = e.note?.id ?? e.savedId;
  // 新建的保存成功：地址换成这一条（不新压历史）
  useEffect(() => {
    if (id === null && e.savedId) void replaceRoute('vault', e.savedId);
  }, [id, e.savedId]);
  const err = e.error === 'image' ? t('vault.edit.imageFail', {}) : errText(e.error);

  return (
    <section data-testid="vault-edit">
      <div className={styles.top}>
        <BackLink label={t('vault.title', {})} onBack={() => void navigate('vault')} testId="vault-edit-back" />
        <h1 className={styles.h1}>{id === null && !e.savedId ? t('vault.edit.new', {}) : t('vault.title', {})}</h1>
        <p className={styles.status} role="status" data-testid="vault-edit-status">
          {status}
        </p>
      </div>
      {missing ? (
        <p className={styles.empty}>{t('vault.err.notFound', {})}</p>
      ) : (
        <>
          <input
            className={styles.editTitle}
            value={e.title}
            maxLength={VAULT_TITLE_MAX}
            placeholder={t('vault.edit.title', {})}
            aria-label={t('vault.edit.title', {})}
            onChange={(ev) => e.setTitle(ev.target.value)}
            data-testid="vault-edit-title"
          />
          <textarea
            className={styles.editBody}
            value={e.body}
            maxLength={VAULT_BODY_MAX}
            placeholder={t('vault.edit.body', {})}
            aria-label={t('vault.edit.body', {})}
            onChange={(ev) => e.setBody(ev.target.value)}
            data-testid="vault-edit-body"
          />
          {e.images.length || e.adds.length ? (
            <div className={styles.imgs}>
              {e.images.map((im) => (
                <SavedImage key={im.id} id={im.id} onRemove={() => e.removeImage(im.id)} />
              ))}
              {e.adds.map((a) => (
                <div key={a.key} className={styles.img} data-testid="vault-img-new">
                  <BlobImg url={a.preview} alt={t('vault.edit.image', {})} />
                  <button type="button" className={styles.imgDel} aria-label={t('vault.edit.removeImage', {})} onClick={() => e.dropAdd(a.key)}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {err ? (
            <p className={styles.notice} role="alert" data-testid="vault-edit-err">
              {err}
            </p>
          ) : null}
          <input
            ref={file}
            className={styles.fileInput}
            type="file"
            accept="image/*"
            multiple
            tabIndex={-1}
            aria-hidden="true"
            onChange={(ev) => {
              const files = [...(ev.target.files ?? [])];
              ev.target.value = '';
              if (files.length) void e.addFiles(files);
            }}
            data-testid="vault-edit-file"
          />
          <div className={styles.editActs}>
            <FormButton variant="primary" disabled={e.busy || (!e.title.trim() && !e.body.trim())} onClick={() => void save()} data-testid="vault-edit-save">
              {t('vault.edit.save', {})}
            </FormButton>
            <FormButton disabled={e.busy} onClick={() => file.current?.click()} data-testid="vault-edit-add-image">
              {t('vault.edit.addImage', {})}
            </FormButton>
            {savedId ? (
              <>
                <FormButton
                  onClick={() => void s.exportNote(savedId).then((r) => (r.ok ? navigate('vault') : setStatus(errText(r.code))))}
                  data-testid="vault-edit-move-out"
                >
                  {t('vault.moveOut', {})}
                </FormButton>
                <FormButton danger onClick={() => void s.remove(savedId).then((r) => (r.ok ? navigate('vault') : setStatus(errText(r.code))))} data-testid="vault-edit-delete">
                  {t('vault.delete', {})}
                </FormButton>
              </>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
