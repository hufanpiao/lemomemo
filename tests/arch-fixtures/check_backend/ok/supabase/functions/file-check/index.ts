import { withAiUser as withUser } from '../_shared/db.ts';
import { store } from '../_shared/objstore.ts';
export const x = [withUser('fn_ai'), store];
