-- 违规 M3（TC-B0-68）：在建表文件里用 update 打开 anniv
update public.app_config set features = jsonb_set(features, '{anniv,on}', 'true');
-- 违规 M3（QA 第二轮 D-15）：改列默认值打开 note
alter table public.app_config alter column features set default '{"event":{"on":true},"todo":{"on":true},"note":{"on":true},"anniv":{"on":false}}';
-- 违规 M3（QA 第二轮 D-15）：带引号、only、和别的子句写在一句里，默认值不是 JSON 字面量（查不了里面开没开）
alter table only "public"."app_config" alter column label drop not null,
  alter column "features" set default jsonb_build_object('note', jsonb_build_object('on', true));
-- 对照：列默认值只有 event、todo 开着，不报
alter table public.app_config alter column features set default '{"event":{"on":true},"todo":{"on":true},"note":{"on":false},"anniv":{"on":false}}';
-- 违规 M3（代码第三轮新低 1）：同一句里第一个 set default 写在注释里、第二个子句才真打开 note（原先只看第一处，被注释骗过）
alter table public.app_config
  -- alter column features set default '{"event":{"on":true},"todo":{"on":true},"note":{"on":false},"anniv":{"on":false}}',
  alter column features set default '{"event":{"on":true},"todo":{"on":true},"note":{"on":false},"anniv":{"on":false}}',
  alter column features set default '{"event":{"on":true},"todo":{"on":true},"note":{"on":true},"anniv":{"on":false}}';
-- 对照：字符串里出现 set default 字样不算（只在字符串外面找）
alter table public.app_config alter column label set default 'alter column features set default ''{"note":{"on":true}}''';
