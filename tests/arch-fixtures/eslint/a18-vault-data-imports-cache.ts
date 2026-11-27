// arch-fixture: path=src/features/vault/data/bad.ts expect=no-restricted-imports message=A18 rule=A18
// 违规：隐私记的明文不进本机缓存
import { put } from '../../../core/cache.ts';
export const save = put;
