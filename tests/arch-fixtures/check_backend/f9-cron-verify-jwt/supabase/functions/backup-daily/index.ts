// F9 样例：违规 ②——函数本身没验 cron 密钥
export const h = (r: Request) => r.headers.get('authorization');
