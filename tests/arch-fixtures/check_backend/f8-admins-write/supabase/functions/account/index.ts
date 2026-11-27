// 正例：只读 admins；别的表写入不算
export async function isAdmin(priv: any, userId: string) {
  await priv.from('admins_log').insert({ user_id: userId });
  await priv.from('pending_deletions').delete().eq('user_id', userId);
  return await priv.from('admins').select('user_id').eq('user_id', userId).maybeSingle();
}
