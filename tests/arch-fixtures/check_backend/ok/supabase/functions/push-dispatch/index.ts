// 不碰数据库直连、不碰 R2：只经 _shared/auth.ts
import { q } from '../_shared/auth.ts';
export const x = q;
