-- 迁移 20261123120000_mascot_private_bucket.sql：吉祥物私有桶
-- 覆盖：桶不公开、限类型和大小；匿名、非管理员读不到；管理员读得到；任何客户端角色都写不进
-- 用户：A 管理员、B 普通账号（tests.seed）；对象是假路径，不含真实文件
begin;
select plan(9);
\ir _helpers.psql
select tests.seed();

insert into private.admins (user_id) values ('aaaaaaaa-0000-4000-8000-000000000001');
insert into storage.objects (bucket_id, name) values ('mascot-private', 'rls-probe.riv');

select is((select public from storage.buckets where id = 'mascot-private'), false, '桶不公开');
select is((select file_size_limit from storage.buckets where id = 'mascot-private'), 1048576::bigint, '单个文件上限 1 MB');
select is((select allowed_mime_types from storage.buckets where id = 'mascot-private'), array['application/x-rive'], '只收 .riv 类型');
select is((select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects'), 1, 'storage.objects 上只有这一条策略');

select is(jsonb_array_length(tests.rows_as('anon', null, $$select name from storage.objects where bucket_id = 'mascot-private'$$)), 0, '匿名读不到');
select is(jsonb_array_length(tests.rows_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$select name from storage.objects where bucket_id = 'mascot-private'$$)), 0, '非管理员读不到');
select is(jsonb_array_length(tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select name from storage.objects where bucket_id = 'mascot-private'$$)), 1, '管理员读得到');

select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$insert into storage.objects (bucket_id, name) values ('mascot-private', 'x.riv')$$) like '42501%', '管理员也写不进');
select ok(tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$insert into storage.objects (bucket_id, name) values ('mascot-private', 'y.riv')$$) like '42501%', '非管理员写不进');

select * from finish();
rollback;
