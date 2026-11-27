// F9-reverse-check 样例：对照——只在注释里写了 'x-cron-secret'，不算验了
/* r.headers.get('x-cron-secret') */
export const h = (r: Request) => r.headers.get('authorization');
