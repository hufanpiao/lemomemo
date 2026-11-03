// F9 样例：验 cron 密钥
export const h = (r: Request) => r.headers.get('x-cron-secret');
