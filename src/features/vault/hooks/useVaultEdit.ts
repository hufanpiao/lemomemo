// 隐私记的编辑页、图片（B5 S5、S8）：明文只在会话内存里（data/session.ts），编辑页的草稿只在组件 state 里，上锁时页面整个换成解锁卡
// • 保存：点“保存”才发 vault {save}（隐私记不进本机 outbox、不自动保存：明文不能落本机，A18）
// • 插图：选的照片在本机重新编码成 webp（和随手记共用 platform/image-encode.ts，tz 传 null 不读拍摄时间，S8）→ save 的 add_images 预登记 → 经 vault-image 上传（整块评审第 3 条）
// • 显示图片：useVaultImage 经会话拿 blob URL（只在内存、上锁时撤销，D3）
// • id 一开始就定：新建的这一条用 draftId，每张待传的图用 PendingImage.key 当图片 id——保存失败重试时复用，服务器“已有就改”、
//   同一个键再传算成功，不会多建一条、不会在 R2 留多份对象（11-14 独立评审 M1 及低项）
// • 改标题、正文时调会话的 touch()：一直在写的人令牌按 5 分钟续一次，写超过 10 分钟再保存也不会被锁、草稿不丢（M2）。
//   放着不动超过 10 分钟、或连续解锁超过 12 小时（第 22 条，令牌不再续），再打字或保存会要求解锁：页面换成解锁卡、DOM 里不留明文（TC-B5-11）；
//   这种“令牌过期、等解锁”的上锁时还没存的草稿交给会话的 saveWhenUnlocked，只在内存闭包里，解锁后保存一次（不丢草稿）；
//   用户主动上锁、离开超时、在别处改密码、设备被移除时照旧丢掉
import { useEffect, useRef, useState } from 'react';
import type { VaultNote } from '../../../../shared/schema/vault.ts';
import { encodeImage } from '../../../platform/image-encode.ts';
import type { VaultCode } from '../data/vault-errors.ts';
import { useVault } from './useVault.ts';

export interface PendingImage {
  /** 也是上传用的图片 id */
  key: string;
  full: Blob;
  thumb: Blob;
  width: number;
  height: number;
  preview: string;
}

export function useVaultImage(imageId: string, part: 'full' | 'thumb'): string | null {
  const { s, state } = useVault();
  const [url, setUrl] = useState<string | null>(null);
  const unlocked = state.phase === 'unlocked';
  useEffect(() => {
    let live = true;
    if (!unlocked) {
      setUrl(null);
      return undefined;
    }
    void s.image(imageId, part).then((u) => {
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [s, imageId, part, unlocked]);
  return url;
}

export function useVaultEdit(id: string | null) {
  const { s, state } = useVault();
  const note: VaultNote | null = id ? state.notes?.find((n) => n.id === id) ?? null : null;
  const [draftId] = useState(() => crypto.randomUUID());
  const [title, setTitleRaw] = useState(note?.title ?? '');
  const [body, setBodyRaw] = useState(note?.body ?? '');
  const setTitle = (v: string): void => {
    setTitleRaw(v);
    s.touch();
  };
  const setBody = (v: string): void => {
    setBodyRaw(v);
    s.touch();
  };
  const [adds, setAdds] = useState<PendingImage[]>([]);
  const [removes, setRemoves] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<VaultCode | 'image' | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  // 卸载时的草稿（第 22 条）：每次渲染记下最新的一份；卸载时正在“令牌过期、等解锁”，又有没存的改动，就交给会话解锁后保存
  const latest = useRef({ title, body, adds, removes });
  latest.current = { title, body, adds, removes };
  const baseRef = useRef(note);
  baseRef.current = note ?? baseRef.current;
  useEffect(
    () => () => {
      const st = s.get();
      if (!st.waiting || st.phase === 'unlocked') return;
      const d = latest.current;
      const base = baseRef.current;
      const dirty = d.title.trim() !== (base?.title ?? '') || d.body !== (base?.body ?? '') || d.adds.length > 0 || d.removes.length > 0;
      if (!dirty) return;
      void s.saveWhenUnlocked({
        id: id ?? draftId,
        title: d.title.trim(),
        body: d.body,
        addImages: d.adds.map((a) => ({ id: a.key, full: a.full, thumb: a.thumb, width: a.width, height: a.height })),
        removeImages: d.removes,
      });
    },
    // 只在卸载时跑；id、draftId 在这一页里不变
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s],
  );

  // 本地预览的 blob URL（缩略图）：删掉这张、保存成功、离开编辑页、上锁时撤销
  const previews = useRef(new Set<string>());
  const revoke = (url: string): void => {
    URL.revokeObjectURL(url);
    previews.current.delete(url);
  };
  useEffect(() => () => previews.current.forEach((u) => URL.revokeObjectURL(u)), []);
  // 列表晚到（直接打开 #/vault/<id>）：拿到这一条时填进去一次
  const filled = useRef(note !== null);
  useEffect(() => {
    if (note && !filled.current) {
      filled.current = true;
      setTitleRaw(note.title);
      setBodyRaw(note.body);
    }
  }, [note]);
  useEffect(() => {
    if (state.phase !== 'unlocked') {
      setTitleRaw('');
      setBodyRaw('');
      previews.current.forEach((u) => URL.revokeObjectURL(u));
      previews.current.clear();
      setAdds([]);
      filled.current = false;
    }
  }, [state.phase]);

  const images = (note?.images ?? []).filter((im) => im.deleted_at === null && !removes.includes(im.id));

  return {
    note,
    title,
    body,
    setTitle,
    setBody,
    images,
    adds,
    busy,
    error,
    savedId,
    async addFiles(files: readonly File[]): Promise<void> {
      setBusy(true);
      setError(null);
      const next: PendingImage[] = [];
      for (const f of files) {
        const r = await encodeImage(f, null);
        if (!r.ok) {
          setError('image');
          continue;
        }
        const preview = URL.createObjectURL(r.thumb);
        previews.current.add(preview);
        next.push({ key: crypto.randomUUID(), full: r.full, thumb: r.thumb, width: r.width, height: r.height, preview });
      }
      setAdds((a) => [...a, ...next]);
      setBusy(false);
    },
    dropAdd(key: string): void {
      const hit = adds.find((x) => x.key === key);
      if (hit) revoke(hit.preview);
      setAdds((a) => a.filter((x) => x.key !== key));
    },
    removeImage(imageId: string): void {
      setRemoves((r) => [...r, imageId]);
    },
    async save(): Promise<boolean> {
      setBusy(true);
      setError(null);
      const r = await s.save({
        id: id ?? draftId,
        title: title.trim(),
        body,
        addImages: adds.map((a) => ({ id: a.key, full: a.full, thumb: a.thumb, width: a.width, height: a.height })),
        removeImages: removes,
      });
      setBusy(false);
      if (!r.ok) {
        setError(r.code);
        return false;
      }
      setSavedId(r.value);
      adds.forEach((a) => revoke(a.preview));
      setAdds([]);
      setRemoves([]);
      return true;
    },
  };
}
