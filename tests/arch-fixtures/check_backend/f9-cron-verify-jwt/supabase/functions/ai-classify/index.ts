// F9 样例：违规 ②——只在注释里提到 x-cron-secret，不算验了
export const h = (r: Request) => r.headers.get('authorization');
