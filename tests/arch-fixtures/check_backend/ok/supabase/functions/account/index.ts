import { withUser } from '../_shared/db.ts';
import { store } from '../_shared/objstore.ts';
export const x = [withUser('fn_vault'), store, 'disabled_at'];
