// 对照：白名单按文件登记，别的函数目录里写同样文本、同样声明的取值不放行（第 3 行报）
export const note = 'todo-remind';
export function same(row: Record<string, unknown>, flag: string) { return row[flag]; }
