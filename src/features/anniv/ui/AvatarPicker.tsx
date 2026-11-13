// 头像选区（B5 S16；R-117；代定 D16：不用第三方库，canvas + 指针事件，按需加载）
// • 正方形取景框（圆形遮罩只是示意，存的是正方形，显示时裁成圆）：图片铺满取景框，拖动挪位置；双指捏合、滚轮、下面的滑块缩放（1～4 倍）
// • 图片不能拖出取景框（四边都有图）；“用这张”按原图像素算选区，交给 data/avatar.ts 编码成 256 × 256 webp（≤ 100 KB，丢掉 EXIF）
// • 解码用浏览器的 createImageBitmap（按 EXIF 方向转正；HEIC 能不能打开看浏览器，R-377）；打不开回 onDone(null)，编辑页提示换一张
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { Dialog } from '../../../kit/components/Dialog.tsx';
import { FormButton } from '../../../kit/components/Form.tsx';
import { useBlobSrc } from '../../../kit/hooks/useBlobSrc.ts';
import { encodeAvatar, type Crop } from '../data/avatar.ts';
import { useAnnivT } from '../hooks/useAnnivT.ts';
import styles from './AnnivPage.module.css';

/** 取景框边长（CSS 像素） */
const VIEW = 260;
const ZOOM_MAX = 4;

export interface View {
  /** 1～ZOOM_MAX */
  z: number;
  /** 图片左上角相对取景框的位置（CSS 像素，≤ 0） */
  x: number;
  y: number;
}

/** 缩放 z 时图片在取景框里的比例（铺满：短边 = 取景框） */
export const scaleOf = (w: number, h: number, z: number): number => (VIEW / Math.min(w, h)) * z;

/** 把位置收进“四边都有图”的范围 */
export function clampView(v: View, w: number, h: number): View {
  const z = Math.min(ZOOM_MAX, Math.max(1, v.z));
  const s = scaleOf(w, h, z);
  return { z, x: Math.min(0, Math.max(VIEW - w * s, v.x)), y: Math.min(0, Math.max(VIEW - h * s, v.y)) };
}

/** 绕取景框中心缩放到 z */
export function zoomTo(v: View, z: number, w: number, h: number): View {
  const s0 = scaleOf(w, h, v.z);
  const s1 = scaleOf(w, h, Math.min(ZOOM_MAX, Math.max(1, z)));
  const c = VIEW / 2;
  return clampView({ z, x: c - ((c - v.x) / s0) * s1, y: c - ((c - v.y) / s0) * s1 }, w, h);
}

/** 取景框对应的原图正方形 */
export function cropOf(v: View, w: number, h: number): Crop {
  const s = scaleOf(w, h, v.z);
  return { x: -v.x / s, y: -v.y / s, size: VIEW / s };
}

export default function AvatarPicker({ file, onDone, onCancel }: { file: File; onDone(b: Blob | null): void; onCancel(): void }) {
  const t = useAnnivT();
  const [img, setImg] = useState<{ bmp: ImageBitmap; url: string } | null>(null);
  const [v, setV] = useState<View>({ z: 1, x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const imgRef = useBlobSrc(img?.url ?? '');

  useEffect(() => {
    let live = true;
    let made: { bmp: ImageBitmap; url: string } | null = null;
    createImageBitmap(file, { imageOrientation: 'from-image' })
      .then((bmp) => {
        if (!live) return bmp.close();
        made = { bmp, url: URL.createObjectURL(file) };
        setImg(made);
        const s = scaleOf(bmp.width, bmp.height, 1);
        setV({ z: 1, x: (VIEW - bmp.width * s) / 2, y: (VIEW - bmp.height * s) / 2 });
      })
      .catch(() => live && onDone(null));
    return () => {
      live = false;
      if (made) {
        made.bmp.close();
        URL.revokeObjectURL(made.url);
      }
    };
    // onDone 不进依赖：换一个回调不重新解码
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const w = img?.bmp.width ?? 1;
  const h = img?.bmp.height ?? 1;
  const s = scaleOf(w, h, v.z);

  const down = (e: RPointerEvent<HTMLDivElement>): void => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // jsdom 没有指针捕获
    }
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const move = (e: RPointerEvent<HTMLDivElement>): void => {
    const m = ptrs.current;
    const prev = m.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    if (m.size >= 2) {
      const other = [...m.entries()].find(([id]) => id !== e.pointerId)?.[1];
      if (other) {
        const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
        const d1 = Math.hypot(cur.x - other.x, cur.y - other.y);
        if (d0 > 0) setV((x) => zoomTo(x, x.z * (d1 / d0), w, h));
      }
    } else {
      setV((x) => clampView({ ...x, x: x.x + cur.x - prev.x, y: x.y + cur.y - prev.y }, w, h));
    }
    m.set(e.pointerId, cur);
  };
  const up = (e: RPointerEvent<HTMLDivElement>): void => void ptrs.current.delete(e.pointerId);

  const ok = async (): Promise<void> => {
    if (!img) return;
    setBusy(true);
    onDone(await encodeAvatar(img.bmp, cropOf(v, w, h)));
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()} title={t('anniv.crop.title', {})} description={t('anniv.crop.hint', {})}>
      <div
        className={styles.crop}
        role="img"
        aria-label={t('anniv.crop.area', {})}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onWheel={(e) => setV((x) => zoomTo(x, x.z * (e.deltaY < 0 ? 1.1 : 1 / 1.1), w, h))}
        data-testid="anniv-crop"
      >
        {img ? <img ref={imgRef} className={styles.cropImg} alt="" draggable={false} style={{ width: w * s, height: h * s, transform: `translate(${v.x}px, ${v.y}px)` }} /> : null}
        <span className={styles.cropMask} aria-hidden="true" />
      </div>
      <label className={styles.zoom}>
        {t('anniv.crop.zoom', {})}
        <input type="range" min={1} max={ZOOM_MAX} step={0.01} value={v.z} onChange={(e) => setV((x) => zoomTo(x, Number(e.target.value), w, h))} data-testid="anniv-crop-zoom" />
      </label>
      <div className={styles.cropActions}>
        <FormButton onClick={onCancel}>{t('anniv.crop.cancel', {})}</FormButton>
        <FormButton variant="primary" disabled={!img || busy} onClick={() => void ok()} data-testid="anniv-crop-ok">
          {t('anniv.crop.ok', {})}
        </FormButton>
      </div>
    </Dialog>
  );
}
