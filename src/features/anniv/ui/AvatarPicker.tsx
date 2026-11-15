// 纪念日头像的选区（B5 S16；R-117）：R-384 起本体挪到 kit/components/AvatarPicker.tsx（和设置里的我的头像共用），这里只接上纪念日的
// 文案（anniv.crop.*）、编码（data/avatar.ts，日志前缀 anniv）、运行日志前缀和 data-testid 前缀 anniv；AnnivAvatarRow 照旧按需加载这一份
import KitAvatarPicker from '../../../kit/components/AvatarPicker.tsx';
import { rlog } from '../../../platform/run-log-api.ts';
import { encodeAvatar } from '../hooks/anniv-view.ts';
import { useAnnivT } from '../hooks/useAnnivT.ts';

export { AVATAR_FILE_MAX, clampView, cropOf, decodeSize, scaleOf, zoomTo } from '../../../kit/components/AvatarPicker.tsx';

const log = (line: string): void => rlog(`anniv ${line}`);
const encode = (src: ImageBitmap, crop: { x: number; y: number; size: number }): Promise<Blob | null> => encodeAvatar(src, crop);

export default function AvatarPicker({ file, onDone, onCancel }: { file: File; onDone(b: Blob | null): void; onCancel(): void }) {
  const t = useAnnivT();
  const text = {
    title: t('anniv.crop.title', {}),
    hint: t('anniv.crop.hint', {}),
    area: t('anniv.crop.area', {}),
    zoom: t('anniv.crop.zoom', {}),
    ok: t('anniv.crop.ok', {}),
    cancel: t('anniv.crop.cancel', {}),
  };
  return <KitAvatarPicker file={file} onDone={onDone} onCancel={onCancel} encode={encode} text={text} log={log} testId="anniv" />;
}
