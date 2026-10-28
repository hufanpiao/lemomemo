-- expect-old-client: fail
-- 兼容样例的反例（TC-B0-57）：改列名。旧版客户端还在写 important，改名以后写入失败 —— 必须改成“先加新列、双写、下一版再删”
-- 迁移文件里出现 rename column / drop column 由前端 B 的 compat 检查拦下；这里只演示旧版契约会断
alter table public.todos rename column important to starred;
