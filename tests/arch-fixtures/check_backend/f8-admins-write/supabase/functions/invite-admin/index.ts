// 反例：服务器函数删管理员
export async function drop(priv: any, userId: string) {
  const read = await priv.from('admins').select('user_id').maybeSingle();
  await priv.from(`admins`).delete().eq('user_id', userId);
  return read;
}
