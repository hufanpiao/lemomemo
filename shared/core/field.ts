// 读行里的列值（改善报告第七节“低风险的重复清理”：原来二十来个文件各写一行同样的小工具）
// • str：不是字符串当空串
// • strOrNull：不是字符串当 null（空串照旧是空串）
// • textOrNull：不是字符串、或是空串，都当 null（日程、待办编辑页读可空的列：time、tz、due、due_time；独立评审 11-18 三-12 收成这一份）
// • numOr(v, d)：是有限的数就用它，不然用 d（各处的默认值由调用方传：0、null 或别的数）
// • isDel：deleted_at 这一列算不算“已删”（null、undefined 都算没删）
// • isObj：是不是普通对象（不是 null、不是数组）。shared/logic/files/preview-protocol.ts 那份数组也认，语义不同，不并进来
// 前端各层、shared 引这一份；服务器函数经 _shared/gen/core/field.ts（build/copy_shared.mjs 复制）引同一份
// 纯函数，不 import 任何东西
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
export function numOr<D>(v: unknown, d: D): number | D {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
export const isDel = (v: unknown): boolean => v !== null && v !== undefined;
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
