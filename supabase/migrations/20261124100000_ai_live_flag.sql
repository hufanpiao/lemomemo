-- 20261124100000_ai_live_flag.sql：按住“＋”走 Gemini 实时转写（11-24 负责人选“改走录音加云端转写”）的服务器开关 features.live。
-- ai-live-token 门第 ④ 步看它（core.ts 的 LIVE_FLAG，经 wire.ts 的 aiFeatures need 'live'；11-24 独立评审第 17 条）：
--   关了（或删掉这个键）回 {fallback, reason: 'feature_off'}，客户端不连 Gemini、整段录音上传 ai-voice，别的 AI 不受影响。
-- 这里打开（建表文件 0001～0007 不准开开关，check_backend M3）。不建表、不改授权。
-- 回滚：update public.app_config set features = features - 'live' where id = 1;
update public.app_config set features = jsonb_set(features, '{live}', '{"on": true}') where id = 1;   -- 11-24  Gemini 实时转写开关
