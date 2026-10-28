// 对照 A14：只有前缀字面量（像 supabase-js 那样拿前缀做判断），或前缀后面不足 20 个字符，都不报
export const isSecret = (k: string) => k.startsWith('sb_secret_');
export const isPublishable = (k: string) => k.startsWith('sb_publishable_') || k.startsWith('sbp_');
export const short = 'sb_secret_xxxxxxxxxxxxxxxxxxx';
