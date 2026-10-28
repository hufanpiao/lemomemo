-- 违规 M3（TC-B0-68）：在建表文件里用 update 打开 anniv
update public.app_config set features = jsonb_set(features, '{anniv,on}', 'true');
