// 纪念日头像的取图和缓存：images 桶 <user_id>/anniv/<anniv_id>/<avatar_id>.webp → blob: 地址
// 做法在头像仓 core/avatar-store.ts（和我的头像共用：地址的生成和撤销、Cache Storage、不再用的撤掉；取图在 core/avatar-view.ts）；
// 这里只给纪念日的参数：缓存 lemo-anniv-avatar、键前缀 __anniv-avatar、日志前缀 anniv、路径函数，还在用的 = anniversaries 里没删的行的 avatar_id
// 只由 hooks/useAnnivAvatar 按需动态 import（data/avatar.ts 静态引它，也只在编辑页按需加载）
import { createAvatarStore } from '../../../core/avatar-store.ts';
import { collection } from '../../../core/store.ts';

type Row = { id: string; avatar_id?: unknown; deleted_at?: unknown };

const view = createAvatarStore({
  cache: 'lemo-anniv-avatar',
  keyPrefix: '__anniv-avatar',
  tag: 'anniv',
  path: (userId: string, annivId: string, avatarId: string): string => `${userId}/anniv/${annivId}/${avatarId}.webp`,
  live: () => new Set(collection<Row>('anniversaries').getSnapshot().flatMap((r) => (typeof r.avatar_id === 'string' && (r.deleted_at ?? null) === null ? [r.avatar_id] : []))),
  watch: (fn) => void collection<Row>('anniversaries').subscribe(fn),
});

/** 头像路径（库里 files_authorize 认的拼法） */
export const avatarPath = view.path;
/** 已经有的地址（同步取） */
export const peekAvatar = view.peek;
/** 本机刚编码的那一张（编辑页写完行、上传之前记下：列表、今天页直接用） */
export const seedAvatar = view.seed;
/** 取一张：回 blob: 地址，取不到回 null */
export const loadAvatar = view.load;
/** 地址有增减时通知 */
export const subscribeAvatars = view.subscribe;
