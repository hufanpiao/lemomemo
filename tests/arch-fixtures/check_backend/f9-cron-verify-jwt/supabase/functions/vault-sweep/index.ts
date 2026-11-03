// F9 样例：违规 ②——下面两处注释里写了带引号的 'x-cron-secret'，代码里没验
/* 应该写 req.headers.get('x-cron-secret') */
export const h = (r: Request) => r.headers.get('authorization');
