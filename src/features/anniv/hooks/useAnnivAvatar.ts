// 纪念日头像的 blob: 地址（B5 S16）：行里有 avatar_id 才去取；取图的那一份（data/avatar-view.ts，带 platform/files.ts）按需下载，不进首屏
// 没头像、还在取、取不到都回 null（kit 的 AnnivAvatar 画名字第一个字加类型颜色的圆，R-121）
import { useEffect, useState } from 'react';
import { getBoot } from '../../../core/boot.ts';
import type * as ViewNs from '../data/avatar-view.ts';

type View = typeof ViewNs;
let view: View | null = null;
const loadView = (): Promise<View> => import('../data/avatar-view.ts').then((m) => (view = m));

export function useAnnivAvatar(annivId: string, avatarId: unknown): string | null {
  const id = typeof avatarId === 'string' && avatarId !== '' ? avatarId : null;
  const [url, setUrl] = useState<string | null>(() => (id && view ? view.peekAvatar(id) : null));
  useEffect(() => {
    const uid = getBoot()?.userId ?? null;
    if (id === null || uid === null) {
      setUrl(null);
      return undefined;
    }
    let live = true;
    void loadView()
      .then((v) => v.peekAvatar(id) ?? v.loadAvatar(v.avatarPath(uid, annivId, id)))
      .then((u) => live && setUrl(u))
      .catch(() => live && setUrl(null));
    return () => {
      live = false;
    };
  }, [annivId, id]);
  return url;
}
