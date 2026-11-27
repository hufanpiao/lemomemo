// ⑦ 违规 3：别的函数读拉备份的密钥
export const peek = Deno.env.get('BACKUP_PULL_TOKEN');
