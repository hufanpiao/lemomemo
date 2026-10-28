-- expect: private.revoked_sessions 写 onAccountDelete: cascade，user_id 却没有 references auth.users on delete cascade
-- 架构 0.31 第 15 条：清单写 cascade 的表，外键少了 on delete cascade（注销后吊销记录留下来）
alter table private.revoked_sessions drop constraint revoked_sessions_user_id_fkey;
alter table private.revoked_sessions add foreign key (user_id) references auth.users;
