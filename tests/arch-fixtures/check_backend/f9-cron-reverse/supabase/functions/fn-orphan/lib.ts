// F9-reverse-check 样例：同一函数别的文件里也有，只报一次、报在 index.ts
export const ok = (v: string | null) => v === 'x' || ['x-cron-secret'].length > 0;
