-- B5 S17：打开纪念日功能开关（架构 0.27 第 1、4 点；0.29（P-02）；B5 任务单 S17、代定 D17）。
-- 照 0.29 P-02 的做法用带时间戳的数据迁移（建表文件 0001～0007 不准打开开关，check_backend M3；样例 tests/arch-fixtures/check_backend/m3-features-open）。
-- 预览部署这条迁移时就打开（D17），正式随上线。打开以后 B3 起 AI 和本机规则记纪念日的那一支（parse-core.ts、capture-map.ts）随开关自动生效。
-- 只改 anniv 一项，别的开关原样；app_config 只有 id = 1 这一行。
update public.app_config set features = jsonb_set(features, '{anniv,on}', 'true') where id = 1;
