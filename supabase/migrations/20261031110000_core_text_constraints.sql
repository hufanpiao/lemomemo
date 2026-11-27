-- 20261031110000_core_text_constraints.sql：同步表文本列补长度和取值约束（架构 0.47 第 20 条 ③；数据字典 P-16；TC-B1-145～147）
-- 客户端可以绕过 zod 直接经 REST 写，库里的 check 是唯一硬上限；照 events 已有的口径补齐 anniversaries、todos、notes。
-- 不改 0001～0007（TC-B1-146 ①）。
--
-- 取值清单以代码里实际会写的值为准（10-31 grep 过 src、shared、supabase/functions、supabase/migrations）：
--   todos.source、notes.source：客户端 zod（shared/schema/rows.ts 的 source）只认 page / chat / voice / import，和 events 一样；
--   todos.ai_status：没有任何代码写非默认值；照 events 的 none / pending / done / rule / skipped（数据字典 4.9）；
--   notes.category_source：只有默认值 'none' 在写（ai-classify 还没写）；清单 ai / rule / manual / none（数据字典 4.11）；
--   notes.ai_status：只有默认值 'pending' 在写；清单 pending / done / rule（数据字典 4.11）；
--   todos.remind_time：客户端 zod 是 hm（^([01]\d|2[0-3]):[0-5]\d$），和 due_time、events.time 同一格式；not null，默认 '09:00'。
-- notes.tags：最多 20 个；每个标签 1～20 字（按 char_length，即码点数）。没有 AI 分类输出和界面在写标签，按架构建议定 20 字；
--   空串标签没有意义，一并拒（数组里的 null 也拒）。检查每一项用 private.tags_ok（immutable、search_path 空，空数组和 null 都算通过）。
--
-- 写法：每条约束先 add … not valid，再 validate（TC-B1-146 ①）。整个文件在一个事务里：库里已有违规旧行时 validate 失败，
--   整个迁移回滚、表结构不变（发布会停下，不会半途改坏）。表在预览里只有测试数据、正式库还是空的，validate 很快。
-- 约束名带列名（如 todos_project_len），违规时 23514 的报错里能读出是哪一列；经 apply_patch 写时转成 patch_bad_args、detail 23514。
-- D1（build/d1/checks.ts 第 11c 节）核对“9 张同步表里客户端可写的 text、text[]、jsonb 列都有长度或取值约束”。
-- 10-31 D1 又查出 9 列（架构 0.47 第 20 条补、0.47 续 ①“同步表文本列”的表），一并加在这里（这个迁移还没部署过）：
--   categories.color、devices.label、devices.app_version、events.tz、note_files.mime（和 kind 一一对应）、note_files.sha256、
--   note_images.mime、notes.converted_to（只管类型和大小；大小按 jsonb 的文字形式 octet_length(converted_to::text)，不用 pg_column_size——那是存储大小，会随压缩和 toast 变，安全审查 10-31）、settings.key。
--   settings.key：10-31 grep 过，现有代码只 insert ai.enabled、ai.vault（src/core/ai-settings.ts、record_consent 等迁移）；
--   数据字典第 9 节的键（ui.font、notes.view@mobile、layout.<页>@inst:<install_id> 等）都符合下面的正则。
--   categories.color、notes.converted_to 现在没有代码写（B4 才写），B4 的 zod 照这里的正则和大小写。

-- ---------- 标签逐项检查 ----------
create function private.tags_ok(p text[]) returns boolean
  language sql immutable parallel safe set search_path = '' as $$
  select coalesce(bool_and(t is not null and pg_catalog.char_length(t) between 1 and 20), true) from pg_catalog.unnest(p) as u(t)
$$;
-- check 约束里的函数按写入的角色查执行权：写 notes 的三种角色都要能执行（客户端、服务器函数、vault 函数移进移出）
grant execute on function private.tags_ok(text[]) to authenticated;   -- B1 新迁移（0.47 第 20 条）  notes.tags 的 check 约束用
grant execute on function private.tags_ok(text[]) to service_role;    -- B1 新迁移（0.47 第 20 条）  notes.tags 的 check 约束用（服务器函数写 notes）
grant execute on function private.tags_ok(text[]) to fn_vault;        -- B1 新迁移（0.47 第 20 条）  notes.tags 的 check 约束用（vault 函数改 notes）

-- ---------- anniversaries ----------
alter table public.anniversaries add constraint anniversaries_note_len check (char_length(note) <= 2000) not valid;

-- ---------- todos（同 events） ----------
alter table public.todos add constraint todos_project_len check (char_length(project) <= 40) not valid;
alter table public.todos add constraint todos_note_len check (char_length(note) <= 2000) not valid;
alter table public.todos add constraint todos_raw_text_len check (char_length(raw_text) <= 2000) not valid;
alter table public.todos add constraint todos_source_in check (source in ('page', 'chat', 'voice', 'import')) not valid;
alter table public.todos add constraint todos_ai_status_in check (ai_status in ('none', 'pending', 'done', 'rule', 'skipped')) not valid;
alter table public.todos add constraint todos_remind_time_fmt check (remind_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') not valid;

-- ---------- notes ----------
alter table public.notes add constraint notes_raw_text_len check (char_length(raw_text) <= 2000) not valid;
alter table public.notes add constraint notes_source_in check (source in ('page', 'chat', 'voice', 'import')) not valid;
alter table public.notes add constraint notes_category_source_in check (category_source in ('ai', 'rule', 'manual', 'none')) not valid;
alter table public.notes add constraint notes_ai_status_in check (ai_status in ('pending', 'done', 'rule')) not valid;
alter table public.notes add constraint notes_tags_count check (cardinality(tags) <= 20) not valid;
alter table public.notes add constraint notes_tags_items check (private.tags_ok(tags)) not valid;

-- ---------- 架构 0.47 第 20 条补：D1 查出的 9 列 ----------
alter table public.categories add constraint categories_color_fmt
  check (color is null or color ~ '^(#[0-9a-f]{6}|[a-z][a-z0-9-]{0,31})$') not valid;
alter table public.devices add constraint devices_label_len check (label is null or char_length(label) <= 80) not valid;
alter table public.devices add constraint devices_app_version_fmt check (app_version is null or app_version ~ '^[0-9A-Za-z.+-]{1,40}$') not valid;
alter table public.events add constraint events_tz_fmt check (tz is null or (char_length(tz) <= 64 and tz ~ '^[A-Za-z0-9_+/-]+$')) not valid;
-- note_files.mime 和 kind 一一对应（shared/manifests/attachments.ts 的 DOC_MIME 顺序；kind 自己的 check 限了 10 种）
alter table public.note_files add constraint note_files_mime_kind check (mime = case kind
  when 'pdf' then 'application/pdf'
  when 'docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  when 'xlsx' then 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  when 'pptx' then 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  when 'docm' then 'application/vnd.ms-word.document.macroEnabled.12'
  when 'xlsm' then 'application/vnd.ms-excel.sheet.macroEnabled.12'
  when 'pptm' then 'application/vnd.ms-powerpoint.presentation.macroEnabled.12'
  when 'doc' then 'application/msword'
  when 'xls' then 'application/vnd.ms-excel'
  when 'ppt' then 'application/vnd.ms-powerpoint'
  end) not valid;
alter table public.note_files add constraint note_files_sha256_fmt check (sha256 ~ '^[0-9a-f]{64}$') not valid;
alter table public.note_images add constraint note_images_mime_webp check (mime = 'image/webp') not valid;
alter table public.notes add constraint notes_converted_to_size
  check (converted_to is null or (jsonb_typeof(converted_to) in ('object', 'array') and octet_length(converted_to::text) <= 2048)) not valid;
alter table public.settings add constraint settings_key_fmt check (char_length(key) between 1 and 80
  and key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_-]+)*(@(mobile|desktop|inst:[0-9a-f-]{36}))?$') not valid;

-- ---------- validate ----------
alter table public.anniversaries validate constraint anniversaries_note_len;
alter table public.todos validate constraint todos_project_len;
alter table public.todos validate constraint todos_note_len;
alter table public.todos validate constraint todos_raw_text_len;
alter table public.todos validate constraint todos_source_in;
alter table public.todos validate constraint todos_ai_status_in;
alter table public.todos validate constraint todos_remind_time_fmt;
alter table public.notes validate constraint notes_raw_text_len;
alter table public.notes validate constraint notes_source_in;
alter table public.notes validate constraint notes_category_source_in;
alter table public.notes validate constraint notes_ai_status_in;
alter table public.notes validate constraint notes_tags_count;
alter table public.notes validate constraint notes_tags_items;
alter table public.categories validate constraint categories_color_fmt;
alter table public.devices validate constraint devices_label_len;
alter table public.devices validate constraint devices_app_version_fmt;
alter table public.events validate constraint events_tz_fmt;
alter table public.note_files validate constraint note_files_mime_kind;
alter table public.note_files validate constraint note_files_sha256_fmt;
alter table public.note_images validate constraint note_images_mime_webp;
alter table public.notes validate constraint notes_converted_to_size;
alter table public.settings validate constraint settings_key_fmt;
