-- 对照：带时间戳的数据迁移打开开关（B4、B5 的正确做法）
update public.app_config set features = jsonb_set(features, '{note,on}', 'true');
