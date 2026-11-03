// F9-reverse-check 样例：对照——只在测试里有 x-cron-secret，不算函数验了
export const h = (r: Request) => r.headers.get('authorization');
