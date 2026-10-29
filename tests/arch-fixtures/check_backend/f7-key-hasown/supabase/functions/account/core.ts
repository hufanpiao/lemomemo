// 代码审查第七轮必改 3：白名单绑到节点位置——和真仓库登记的取值同文本、同参数声明，但位置不同，照报；Object.hasOwn 守卫写对才放行
export const pick = (row: Record<string, unknown>, flag: string) => row[flag];
export function isVaultRow(row: Record<string, unknown>, flag: string): boolean { return row[flag] === true; }
export function g1(row: Record<string, unknown>, other: Record<string, unknown>, k: string) { return Object.hasOwn(other, k) ? row[k] : undefined; }
export function g2(row: any, k: string) { return Object.hasOwn(row, k) ? row[k] : undefined; }
export function g3(row: Record<string, unknown>, k: string) { return Object.hasOwn(row, k) ? undefined : row[k]; }
