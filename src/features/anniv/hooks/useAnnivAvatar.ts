// 纪念日头像的 blob: 地址：行里有 avatar_id 才去取；纪念日那一份头像仓（data/avatar-view.ts → core/avatar-store.ts）按需下载，不进首屏
// 仓里地址有增减（编辑页刚记下本机那一张、换掉了）跟着重查；没头像、还在取、取不到都回 null（kit 的 AnnivAvatar 画名字第一个字加类型颜色的圆）
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
    let off: (() => void) | null = null;
    void loadView()
      .then((v) => {
        if (live) off = v.subscribeAvatars(() => live && setUrl(v.peekAvatar(id)));
        return v.loadAvatar(v.avatarPath(uid, annivId, id)).then((u) => live && setUrl(v.peekAvatar(id) ?? u));
      })
      .catch(() => live && setUrl(null));
    return () => {
      live = false;
      off?.();
    };
  }, [annivId, id]);
  return url;
}
