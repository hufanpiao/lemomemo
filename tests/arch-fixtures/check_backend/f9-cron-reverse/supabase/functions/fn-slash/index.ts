// F9-reverse-check 样例：cron 调的函数，验 cron 密钥
export const h = (r: Request) => r.headers.get('x-cron-secret');
