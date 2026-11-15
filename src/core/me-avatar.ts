// 我的头像（R-384；架构 5.4 头像一段）：头像仓的参数、换头像没传上时的回滚补写
// • meAvatarStore：缓存 lemo-me-avatar、键前缀 __me-avatar、日志前缀 me；还在用的只有 profile 里那一个 avatar_id（core/cache 的 meAvatarId）；
//   profile 变了（applyFreshConfig 通知）按 live 撤掉旧的。kit 的 useMeAvatar 首屏画完后动态加载这里，设置页换头像也用这一份
// • 回滚（整块评审第 2 条）：换头像时先写了 profiles 两列、对象没传上，要把两列改回原值。undoMeAvatar 先把“改回什么”记进本机 meta
//   （me_avatar_undo），再写；写成了删掉这条，没写成就留着：仓第一次用到时、以后每次 applyFreshConfig（启动、回到前台的同步轮）再试，
//   直到写成。写的时候带条件“avatar_id 还是没传上的那一个”：别的设备已经换了新的就不动，也算处理完
// • 运行日志只记 `me avatar-rollback <结果码>`，不记 id
import { createAvatarStore, type AvatarStore } from './avatar-store.ts';
import { applyFreshConfig, getBoot, subscribeProfile } from './boot.ts';
import { meAvatarId } from './cache.ts';
import { rlog } from '../platform/run-log-api.ts';

/** 我的头像：images 桶 <user_id>/me/<avatar_id>.webp */
export const meAvatarPath = (userId: string, avatarId: string): string => `${userId}/me/${avatarId}.webp`;

/** 回滚要写回的：bad 是没传上的那一个 avatar_id，id、bytes 是换之前的两列（原来没有就是 null） */
export interface MeAvatarUndo {
  bad: string;
  id: string | null;
  bytes: number | null;
}

type ProfilesUpdate = {
  from(t: 'profiles'): {
    update(v: { avatar_id: string | null; avatar_bytes: number | null }): {
      eq(c: 'user_id', v: string): { eq(c: 'avatar_id', v: string): PromiseLike<{ error: unknown }> };
    };
  };
};

const metaOf = () => {
  const cache = getBoot()?.cache;
  return cache && !cache.isClosed() ? cache : null;
};

/** 两列改回原值（见文件头）；写成了回 true */
export async function undoMeAvatar(u: MeAvatarUndo): Promise<boolean> {
  const boot = getBoot();
  const meta = metaOf();
  await meta?.setMeta('me_avatar_undo', u).catch(() => undefined);
  let ok = false;
  try {
    if (!boot?.userId) throw new Error('no_user');
    const db = (await (await import('../platform/supabase/client.ts')).getSupabase()) as unknown as ProfilesUpdate;
    const r = await db.from('profiles').update({ avatar_id: u.id, avatar_bytes: u.bytes }).eq('user_id', boot.userId).eq('avatar_id', u.bad);
    ok = !r.error;
  } catch {
    ok = false;
  }
  rlog(`me avatar-rollback ${ok ? 'ok' : 'failed'}`);
  if (!ok) return false;
  await meta?.deleteMeta('me_avatar_undo').catch(() => undefined);
  // 同步轮已经把没传上的那一个拉回本机了：本机也改回去
  if (boot?.profile && meAvatarId(boot.profile) === u.bad) await applyFreshConfig(boot, { profile: { ...boot.profile, avatar_id: u.id, avatar_bytes: u.bytes } }).catch(() => undefined);
  return true;
}

let retrying = false;

/** 本机 meta 里有没写成的回滚就再试一次（同时只试一次） */
async function retryUndo(): Promise<void> {
  if (retrying) return;
  retrying = true;
  try {
    const u = await metaOf()?.getMeta('me_avatar_undo').catch(() => undefined);
    if (u) await undoMeAvatar(u);
  } finally {
    retrying = false;
  }
}

/** 我的头像那一份仓 */
export const meAvatarStore: AvatarStore<[userId: string, avatarId: string]> = createAvatarStore({
  cache: 'lemo-me-avatar',
  keyPrefix: '__me-avatar',
  tag: 'me',
  path: meAvatarPath,
  live: () => {
    const id = meAvatarId(getBoot()?.profile);
    return new Set(id === null ? [] : [id]);
  },
  watch: (fn) => {
    subscribeProfile(() => {
      fn();
      void retryUndo();
    });
    void retryUndo();
  },
});
