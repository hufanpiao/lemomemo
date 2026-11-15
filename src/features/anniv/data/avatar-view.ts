// 纪念日头像的取图和缓存（B5 S16；架构 5.4 头像一段、R-117）：images 桶 <user_id>/anniv/<anniv_id>/<avatar_id>.webp → blob: 地址
// 做法在 core/avatar-view.ts（R-384 起和我的头像共用：批量签名、Cache Storage、blob 地址、不再用的撤掉）；这里只给纪念日的参数：
// 缓存 lemo-anniv-avatar、键前缀 __anniv-avatar、日志前缀 anniv、路径函数，还在用的 = anniversaries 里没删的行的 avatar_id
// 只由 hooks/useAnnivAvatar 按需动态 import（data/avatar.ts 静态引它，也只在编辑页按需加载）（platform/files.ts 带 zod，不进首屏）
import { createAvatarView } from '../../../core/avatar-view.ts';
import { collection } from '../../../core/store.ts';

type Row = { id: string; avatar_id?: unknown; deleted_at?: unknown };

const view = createAvatarView({
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
/** 本机刚编码的那一张（编辑页传完以后列表、今天页直接用） */
export const seedAvatar = view.seed;
/** 取一张：回 blob: 地址，取不到回 null */
export const loadAvatar = view.load;
