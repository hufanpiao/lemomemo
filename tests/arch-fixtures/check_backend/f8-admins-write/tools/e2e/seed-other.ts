// 反例：名单外的脚本写 admins
// 注释里写 c.from('admins').insert() 和 insert into private.admins 不算
export async function seed(c: any, id: string) {
  await c.schema('private').from('admins').insert({ user_id: id });
  await c.schema('private')
    .from("admins")
    .upsert({ user_id: id });
  const ok = await c.schema('private').from('admins').select('user_id').eq('user_id', id);
  return ok;
}
