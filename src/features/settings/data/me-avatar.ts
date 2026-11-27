// 设置 › 账号：换我的头像、去掉头像：纯 TS
// • 换：（选图、裁剪、编码在界面那一侧，platform/avatar-encode.ts）→ ① 直接改 profiles 两列（新的 avatar_id、这张图的字节数）
//   → ② 这一张记进头像仓（core/me-avatar.ts 的 meAvatarStore.seed：地址马上有，字节在后台存进 Cache Storage；和纪念日一样“写完行、上传之前”）
//   → ③ PUT /files/v1/o/images/<uid>/me/<avatar_id>.webp（files_authorize 查本人 profiles 的 avatar_id，所以先写行再传；
//   可重试的错误退避再试两次，core/avatar-view.ts 的 putAvatar，和纪念日头像共用）
//   → ③没成：core/me-avatar.ts 的 undoMeAvatar 把两列改回原值（原来没有就是 null），提示“没传上”；改回也没写成就记进本机 meta，
//     以后每次 applyFreshConfig（启动、回到前台的同步轮）再试，直到写成，不留一个指向空对象的 avatar_id。
//     ②记下的那一张不在 live 里，当场让仓按 live 撤掉、删缓存（meAvatarStore.prune）
//   → 成了：applyFreshConfig 把新的 profile 交给 core/boot：四页右上角、设置首页、侧栏的 MeAvatar 跟着换（仓里已经有这一张，不再去服务器取）
// • 额度满了：① 被数据库的 media_quota_guard 拒（quota_exceeded），或 ③ 的 files_authorize 复核拒（denied:quota_exceeded）：都回 quota_exceeded
// • 去掉：两列写 null；旧对象由以后的 storage-sweep 按 profiles.avatar_id 清（清单 core.ts 我的头像段 orphanSweep）
// • 运行日志只记 `me avatar-<步骤> <结果码>`，不记图片和 id
import { putAvatar } from '../../../core/avatar-view.ts';
import { applyFreshConfig, getBoot } from '../../../core/boot.ts';
import { meAvatarId } from '../../../core/cache.ts';
import { meAvatarPath, meAvatarStore, undoMeAvatar } from '../../../core/me-avatar.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { Failure, SettingsApi } from './settings-api.ts';

export type MeAvatarResult = 'ok' | 'write_failed' | 'upload_failed' | 'quota_exceeded' | 'offline';

/** 写行没成：会话没了、停用这几种交给调用方离开本机（同改语言），界面另提示 */
export type MeAvatarFail = { result: Exclude<MeAvatarResult, 'ok'>; failure?: Failure };

const ofWrite = (f: Failure): Exclude<MeAvatarResult, 'ok'> => (f.error === 'quota_exceeded' ? 'quota_exceeded' : f.error === 'offline' ? 'offline' : 'write_failed');

/** 新的 profile 交给 core/boot（界面跟着换）；库关着、写不进 meta 不挡 */
async function adopt(avatarId: string | null, avatarBytes: number | null): Promise<void> {
  const boot = getBoot();
  if (!boot?.profile) return;
  try {
    await applyFreshConfig(boot, { profile: { ...boot.profile, avatar_id: avatarId, avatar_bytes: avatarBytes } });
  } catch {
    rlog('me avatar-adopt failed');
  }
}

/** 换头像（见文件头） */
export async function changeMeAvatar(api: Pick<SettingsApi, 'saveAvatar'>, blob: Blob): Promise<'ok' | MeAvatarFail> {
  const boot = getBoot();
  const uid = boot?.userId ?? null;
  if (uid === null) {
    rlog('me avatar-write no_user');
    return { result: 'write_failed' };
  }
  const prevId = meAvatarId(boot?.profile);
  const prevBytes = prevId === null ? null : (boot?.profile?.['avatar_bytes'] as number | null | undefined) ?? null;
  const avatarId = crypto.randomUUID();
  const w = await api.saveAvatar(avatarId, blob.size);
  if (!w.ok) {
    rlog(`me avatar-write ${w.error}`);
    return { result: ofWrite(w), failure: w };
  }
  void meAvatarStore.seed(avatarId, blob);
  const r = await putAvatar(meAvatarPath(uid, avatarId), blob);
  if (!r.ok) {
    rlog(`me avatar-upload ${r.kind}:${r.code}`);   // 原因码是服务器的枚举（quota_exceeded 等），不含内容
    await undoMeAvatar({ bad: avatarId, id: prevId, bytes: prevBytes });
    meAvatarStore.prune();   // ②记下的那一张不在 live 里：撤掉、删缓存（profile 没换，不会有通知）
    return { result: r.code === 'quota_exceeded' ? 'quota_exceeded' : 'upload_failed' };
  }
  await adopt(avatarId, blob.size);
  rlog('me avatar-change ok');
  return 'ok';
}

/** 去掉头像：两列写 null */
export async function clearMeAvatar(api: Pick<SettingsApi, 'saveAvatar'>): Promise<'ok' | MeAvatarFail> {
  const w = await api.saveAvatar(null, null);
  if (!w.ok) {
    rlog(`me avatar-clear ${w.error}`);
    return { result: ofWrite(w), failure: w };
  }
  await adopt(null, null);
  rlog('me avatar-clear ok');
  return 'ok';
}
