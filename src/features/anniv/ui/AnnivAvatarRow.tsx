// 纪念日编辑页的头像（B5 S15；R-117、R-121；视觉稿 annface、annnew）：从 AnnivEditor.tsx 分出来（那个文件超 300 行）
// • 编辑页最上面“头像”一行：72px 圆、说明、“去掉”；新建页：名字左边一个头像圆圈，右下角小图标
// • 点圆圈从相册选一张，裁成圆形（AvatarPicker 按需加载）；新建时先写名字存下来（有了 id）才能选
import { lazy, Suspense, useRef, useState } from 'react';
import { Field, FormButton, TextInput } from '../../../kit/components/Form.tsx';
import { clearAvatar, NAME_MAX, setAvatar, type AnnivForm, type AvatarResult } from '../hooks/anniv-view.ts';
import type { AnnivT } from '../hooks/useAnnivT.ts';
import { AnnivFace } from './AnnivFace.tsx';
import styles from './AnnivPage.module.css';

const AvatarPicker = lazy(() => import('./AvatarPicker.tsx'));

const AV_KEY = {
  uploading: 'anniv.av.uploading', ok: 'anniv.av.uploading', encode_failed: 'anniv.av.encode_failed', write_failed: 'anniv.av.write_failed', upload_failed: 'anniv.av.upload_failed',
} as const;

interface PartProps {
  form: AnnivForm;
  off: boolean;
  t: AnnivT;
  change(p: Partial<AnnivForm>): void;
}

/** 头像：点圆圈从相册选、裁成圆形（R-117）；新建页的小圆圈和编辑页的“头像”一行共用（选图、上传、状态） */
function useAvatar(id: string | null, saved: Record<string, unknown> | undefined, off: boolean) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [st, setSt] = useState<AvatarResult | 'uploading' | null>(null);
  const done = async (blob: Blob | null): Promise<void> => {
    setFile(null);
    if (!id) return;
    if (!blob) return setSt('encode_failed');
    setSt('uploading');
    const prevId = saved?.['avatar_id'];
    const prevBytes = saved?.['avatar_bytes'];
    const r = await setAvatar(id, blob, {
      avatar_id: typeof prevId === 'string' ? prevId : null,
      avatar_bytes: typeof prevBytes === 'number' ? prevBytes : null,
    });
    setSt(r === 'ok' ? null : r);
  };
  const node = (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          setFile(e.target.files?.[0] ?? null);
          e.target.value = '';
        }}
        data-testid="anniv-avatar-file"
      />
      {file ? (
        <Suspense fallback={null}>
          <AvatarPicker file={file} onDone={(b) => void done(b)} onCancel={() => setFile(null)} />
        </Suspense>
      ) : null}
    </>
  );
  return { st, has: typeof saved?.['avatar_id'] === 'string', can: id !== null && !off, pick: () => input.current?.click(), node };
}

/** 编辑页最上面“头像”一行（视觉稿 annface：72px 圆、说明、“去掉”） */
export function AvatarRow({ id, form, saved, off, t }: { id: string | null; form: AnnivForm; saved: Record<string, unknown> | undefined; off: boolean; t: AnnivT }) {
  const av = useAvatar(id, saved, off);
  return (
    <div className={styles.avRow} data-testid="anniv-avatar-row">
      <button type="button" className={styles.avBtn} disabled={!av.can} onClick={av.pick} aria-label={t('anniv.edit.avatarPick', {})} data-testid="anniv-avatar-pick">
        <AnnivFace id={id ?? 'new'} avatarId={saved?.['avatar_id']} name={form.name} kind={form.kind} size="lg" />
      </button>
      <span className={styles.avText}>
        <span className={styles.avTitle}>{t('anniv.edit.avatar', {})}</span>
        <span className={styles.hint} role="status">
          {av.st ? t(AV_KEY[av.st], {}) : t(id ? 'anniv.edit.avatarHint' : 'anniv.edit.avatarNeedName', {})}
        </span>
      </span>
      {av.has && av.can && id ? (
        <FormButton onClick={() => void clearAvatar(id)} data-testid="anniv-avatar-remove">
          {t('anniv.edit.avatarRemove', {})}
        </FormButton>
      ) : null}
      {av.node}
    </div>
  );
}


/** 新建页：名字左边一个头像圆圈（视觉稿 annnew；右下角小图标表示可以加；先写名字存下来才能选图） */
export function NameWithAvatar({ id, saved, form, off, t, change }: PartProps & { id: string | null; saved: Record<string, unknown> | undefined }) {
  const av = useAvatar(id, saved, off);
  return (
    <Field label={t('anniv.edit.nameAv', {})} htmlFor="anniv-name">
      <span className={styles.nameRow}>
        <button type="button" className={styles.avBtn} disabled={!av.can} onClick={av.pick} aria-label={t('anniv.edit.avatarPick', {})} data-testid="anniv-avatar-pick">
          <AnnivFace id={id ?? 'new'} avatarId={saved?.['avatar_id']} name={form.name} kind={form.kind} size="md" />
          <span className={styles.avBadge} aria-hidden="true" />
        </button>
        <TextInput id="anniv-name" value={form.name} maxLength={NAME_MAX} disabled={off} placeholder={t('anniv.edit.namePh', {})} onCommit={(v) => change({ name: v.trim() })} data-testid="anniv-edit-name" />
      </span>
      {av.st ? (
        <span className={styles.hint} role="status">
          {t(AV_KEY[av.st], {})}
        </span>
      ) : null}
      {av.node}
    </Field>
  );
}
