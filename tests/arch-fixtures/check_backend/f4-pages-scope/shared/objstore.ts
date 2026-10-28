// 迷你 shared/objstore.ts（注释里提到 R2_FN_* 不算）
export interface ObjStore { k: string }
export function createObjStore(k?: string): ObjStore { return { k: k ?? '' }; }
