// 正例：名单里的文件可以写 admins（R-279）
export async function grant(c: any, userId: string) {
  return await c.schema('private').from('admins').insert({ user_id: userId });
}
