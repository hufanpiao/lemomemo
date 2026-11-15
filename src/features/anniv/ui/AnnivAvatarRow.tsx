// 纪念日编辑页的头像（B5 S15；R-117、R-121；视觉稿 annface、annnew）：从 AnnivEditor.tsx 分出来（那个文件超 300 行）
// • 编辑页顶部主卡（R-436）：头像描边加角标、名字、大号天数；新建页：名字左边一个头像圆圈，右下角同一个角标
// • 点圆圈从相册选一张，裁成圆形（kit 的 AvatarPicker 按需加载，和设置里的我的头像同一份；这里给纪念日的文案 anniv.crop.*、
//   编码 data/avatar.ts、运行日志前缀 anniv、data-testid 前缀 anniv）；新建时先写名字存下来（有了 id）才能选
import { lazy, Suspense, useRef, useState } from 'react';
import type { UiLocale } from '../../../../shared/i18n/pick-locale.ts';
import type { AnnivRec, AnnivState } from '../../../../shared/logic/anniv/next-date.ts';
import type { Crop } from '../../../kit/components/AvatarPicker.tsx';
import { Field, TextInput } from '../../../kit/components/Form.tsx';
import { rlog } from '../../../platform/run-log-api.ts';
import { encodeAvatar, NAME_MAX, setAvatar, type AnnivForm, type AvatarResult } from '../hooks/anniv-view.ts';
import type { AnnivT } from '../hooks/useAnnivT.ts';
import { ageText, heroDateText } from './anniv-text.ts';
import { AnnivFace } from './AnnivFace.tsx';
import styles from './AnnivPage.module.css';

const AvatarPicker = lazy(() => import('../../../kit/components/AvatarPicker.tsx'));
const pickerEncode = (src: ImageBitmap, crop: Crop): Promise<Blob | null> => encodeAvatar(src, crop);
const pickerLog = (line: string): void => rlog(`anniv ${line}`);

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
function useAvatar(id: string | null, saved: Record<string, unknown> | undefined, off: boolean, t: AnnivT) {
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
          <AvatarPicker
            file={file}
            onDone={(b) => void done(b)}
            onCancel={() => setFile(null)}
            encode={pickerEncode}
            text={{
              title: t('anniv.crop.title', {}),
              hint: t('anniv.crop.hint', {}),
              area: t('anniv.crop.area', {}),
              zoom: t('anniv.crop.zoom', {}),
              ok: t('anniv.crop.ok', {}),
              cancel: t('anniv.crop.cancel', {}),
            }}
            log={pickerLog}
            testId="anniv"
          />
        </Suspense>
      ) : null}
    </>
  );
  return { st, has: typeof saved?.['avatar_id'] === 'string', can: id !== null && !off, pick: () => input.current?.click(), node };
}

/** 主卡右边的大号天数（R-436 第 2 条）：“62 / 天后 · 满 66 周岁”；当天“今天”；倒数日过了“3 / 天前” */
function heroDays(r: AnnivRec, st: AnnivState, t: AnnivT): { num: string; sub: string } {
  const age = ageText(r, st, t);
  if (st.past) return { num: String(-st.days), sub: t('anniv.edit.heroAgo', {}) };
  if (st.days === 0) return { num: t('anniv.edit.heroToday', {}), sub: age ?? '' };
  return { num: String(st.days), sub: [t('anniv.near.after', {}), age].filter(Boolean).join(' · ') };
}

/**
 * 编辑页顶部主卡（R-436 精致化对照第 2、3 条）：左边头像（隔一圈缝的柠檬黄细描边、右下角角标，点了从相册换）、名字和原日期（“阴历 · 腊月初九 · 1960”），右边大号等宽天数。
 * 原来的“头像”说明卡、“去掉”按钮不要了：“去掉头像”收进表单最后一行（AnnivEditor 里 FormRowButton）。选图、上传的状态写在名字下面那一行
 */
export function AnnivHero({ id, form, saved, off, t, locale, next }: {
  id: string | null;
  form: AnnivForm;
  saved: Record<string, unknown> | undefined;
  off: boolean;
  t: AnnivT;
  locale: UiLocale;
  /** 下一次（算不出来时 null，右边不画天数） */
  next: { r: AnnivRec; st: AnnivState } | null;
}) {
  const days = next ? heroDays(next.r, next.st, t) : null;
  const av = useAvatar(id, saved, off, t);
  return (
    <div className={styles.hero} data-testid="anniv-hero">
      <button type="button" className={styles.heroAv} disabled={!av.can} onClick={av.pick} aria-label={t('anniv.edit.avatarPick', {})} data-testid="anniv-avatar-pick">
        <AnnivFace id={id ?? 'new'} avatarId={saved?.['avatar_id']} name={form.name} kind={form.kind} size="lg" />
        <span className={styles.avBadge} aria-hidden="true" />
      </button>
      <span className={styles.heroText}>
        <span className={styles.heroName}>{form.name || t('anniv.edit.namePh', {})}</span>
        {av.st ? null : <span className={styles.heroWhen}>{heroDateText(form, locale, t)}</span>}
        {/* 选图、上传的状态（R-117）：常驻的 role=status，平时没字，读屏只播报状态，不播报日期 */}
        <span className={styles.heroWhen} role="status">
          {av.st ? t(AV_KEY[av.st], {}) : id ? '' : t('anniv.edit.avatarNeedName', {})}
        </span>
      </span>
      {days ? (
        <span className={styles.heroDays} data-testid="anniv-edit-next">
          <span className={styles.heroNum}>{days.num}</span>
          <span className={styles.heroSub}>{days.sub}</span>
        </span>
      ) : null}
      {av.node}
    </div>
  );
}

/** 新建页：名字左边一个头像圆圈（视觉稿 annnew；右下角小图标表示可以加；先写名字存下来才能选图） */
export function NameWithAvatar({ id, saved, form, off, t, change }: PartProps & { id: string | null; saved: Record<string, unknown> | undefined }) {
  const av = useAvatar(id, saved, off, t);
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
