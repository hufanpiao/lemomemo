// 设置 › 账号顶部的“更换头像”“去掉头像”：选图 → 裁剪（kit 的 AvatarPicker，按需加载）→ 编码（platform/avatar-encode.ts，日志前缀 me）
// → data/me-avatar.ts 写行、上传、失败回滚、成功写缓存并交给 core/boot。会话没了、停用照改语言那样交给 useSettingsPage 的几个出口
import { useCallback, useState } from 'react';
import { dispatchLoss, type LossExits } from '../../../core/loss-dispatch.ts';
import { encodeAvatar, type Crop } from '../../../platform/avatar-encode.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { changeMeAvatar, clearMeAvatar, type MeAvatarFail, type MeAvatarResult } from '../data/me-avatar.ts';
import type { SettingsApi } from '../data/settings-api.ts';

/** busy：正在写、正在传；encode_failed：图打不开、太大（裁剪框交回 null） */
export type MeAvatarState = 'idle' | 'busy' | 'encode_failed' | Exclude<MeAvatarResult, 'ok'>;

/** 交给 kit 的 AvatarPicker：编码（日志记 me avatar-encode …）、记日志（me avatar-decode …） */
export const meAvatarEncode = (src: ImageBitmap, crop: Crop): Promise<Blob | null> => encodeAvatar(src, crop, 'me');
export const meAvatarLog = (line: string): void => rlog(`me ${line}`);

export type MeAvatarExits = Pick<LossExits, 'onRevoked' | 'onSignedOut' | 'onDisabled'>;

export function useMeAvatarEdit(api: Pick<SettingsApi, 'saveAvatar'>, exits: MeAvatarExits) {
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<MeAvatarState>('idle');

  const settle = useCallback(
    (r: 'ok' | MeAvatarFail): void => {
      if (r === 'ok') return setState('idle');
      dispatchLoss(r.failure, exits);   // 同设备列表、改语言一份分发（revoked 带着原始码和状态）
      setState(r.result);
    },
    [exits],
  );

  /** 裁剪框交回来的图（null = 打不开、编不出） */
  const done = useCallback(
    async (blob: Blob | null): Promise<void> => {
      setFile(null);
      if (!blob) return setState('encode_failed');
      setState('busy');
      settle(await changeMeAvatar(api, blob));
    },
    [api, settle],
  );

  const remove = useCallback(async (): Promise<void> => {
    setState('busy');
    settle(await clearMeAvatar(api));
  }, [api, settle]);

  return { file, state, pick: setFile, cancel: () => setFile(null), done, remove };
}

export type MeAvatarEdit = ReturnType<typeof useMeAvatarEdit>;
