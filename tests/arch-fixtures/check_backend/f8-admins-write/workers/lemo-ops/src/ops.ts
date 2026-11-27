// 反例：SQL 文本写 admins（字符串里的照查）
export const SQL = 'INSERT INTO private.admins (user_id) values ($1)';
export const OK = 'select user_id from private.admins; update private.admins_history set x = 1';
export const BAD = `update "private"."admins" set user_id = $1`;
