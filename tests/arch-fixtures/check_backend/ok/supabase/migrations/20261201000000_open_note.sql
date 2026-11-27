update public.app_config set features = jsonb_set(features, '{note,on}', 'true');
