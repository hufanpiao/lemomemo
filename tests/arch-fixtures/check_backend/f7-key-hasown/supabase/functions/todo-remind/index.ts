// 对照：Object.hasOwn(o, k) ? o[k] : …、Object.hasOwn(o, k) && o[k] 的字典查表不报（只取自有属性）
export function get(row: Record<string, unknown>, k: string) { return Object.hasOwn(row, k) ? row[k] : undefined; }
export function has(row: Record<string, number>, k: string) { const v = Object.hasOwn(row, k) && row[k]; return (v || 0) > 0; }
