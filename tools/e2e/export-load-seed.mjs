// export-full-account.mjs 本机跑法的造数 SQL（经 docker exec 进 supabase_db_lemo-e2e 的 psql 跑；从原脚本原样挪出）。
// profile：typ 各文本列取常见长度；max 取到库里 check 的上限（没有 check 的 note 列按 2000 字）。
// categories 有 (user_id, lower(name)) 唯一索引：名字截短后拼上行号。文本用 3000 个常用区段汉字随机拼（比真实文字更难压缩）；
// 每个文本列先生成 1000 条放进临时表，按行号轮着取。

/** 各文本列的长度（字） */
export function lengths(MAX, notesBody, excerpt) {
  return {
    evTitle: MAX ? 160 : 20, evNote: MAX ? 2000 : 40, evRaw: MAX ? 2000 : 40, evLoc: MAX ? 200 : 10, project: MAX ? 40 : 4, short: MAX ? 32 : 6,
    tdTitle: MAX ? 160 : 20, tdNote: MAX ? 2000 : 40, tdRaw: MAX ? 2000 : 40,
    catName: MAX ? 12 : 4,
    noteTitle: MAX ? 160 : 10, noteBody: notesBody ?? (MAX ? 20000 : 300), noteRaw: MAX ? 2000 : 0,
    imgDesc: MAX ? 200 : 30, fileName: MAX ? 110 : 12, excerpt: excerpt ?? (MAX ? 20000 : 200),
    annName: MAX ? 60 : 6, annNote: MAX ? 2000 : 20,
    setVal: MAX ? 1300 : 4, devLabel: MAX ? 60 : 10,
  };
}

/** 给 uid 造 SYNC 行 × 9 张同步表、LOGS 行 logs 的 SQL；最后一句按表数行数 */
export function seedSql(uid, L, MAX, SYNC, LOGS) {
  return String.raw`
set statement_timeout = 0;
\set ON_ERROR_STOP 1
create function pg_temp.zh(n int) returns text language sql volatile as $f$
  select coalesce(string_agg(chr(19968 + floor(random() * 3000)::int), ''), '') from generate_series(1, n) $f$;
create function pg_temp.az(n int) returns text language sql volatile as $f$
  select coalesce(string_agg(chr(97 + floor(random() * 26)::int), ''), '') from generate_series(1, n) $f$;
create temp table pool (k text, i int, s text, primary key (k, i));
insert into pool select k, i, pg_temp.zh(n) from (values
  ('evTitle', ${Math.max(L.evTitle, 1)}), ('evNote', ${L.evNote}), ('evRaw', ${L.evRaw}), ('evLoc', ${L.evLoc}), ('project', ${L.project}), ('short', ${L.short}),
  ('tdTitle', ${Math.max(L.tdTitle, 1)}), ('tdNote', ${L.tdNote}), ('tdRaw', ${L.tdRaw}), ('catName', ${Math.max(L.catName, 1)}),
  ('noteTitle', ${L.noteTitle}), ('noteBody', ${L.noteBody}), ('noteRaw', ${L.noteRaw}), ('imgDesc', ${L.imgDesc}), ('fileName', ${Math.max(L.fileName, 1)}),
  ('excerpt', ${L.excerpt}), ('annName', ${Math.max(L.annName, 1)}), ('annNote', ${L.annNote}), ('setVal', ${L.setVal}), ('devLabel', ${L.devLabel})
) v(k, n), generate_series(0, 999) i;
create function pg_temp.p(k text, g bigint) returns text language sql stable as $f$ select s from pool where pool.k = $1 and pool.i = ($2 * 7919) % 1000 $f$;

insert into public.profiles (user_id, display_name) values ('${uid}', 'export-load');
insert into public.settings (id, user_id, key, value)
  select gen_random_uuid(), '${uid}', 'load.' || g, to_jsonb(pg_temp.p('setVal', g)) from generate_series(1, ${SYNC}) g;
insert into public.devices (id, user_id, label, platform, push_endpoint, p256dh, auth, app_version, last_seen_at, install_id)
  select gen_random_uuid(), '${uid}', pg_temp.p('devLabel', g), 'web',
    ${MAX ? `'https://fcm.googleapis.com/fcm/send/' || pg_temp.az(140) || g` : 'null'}, ${MAX ? 'pg_temp.az(87)' : 'null'}, ${MAX ? 'pg_temp.az(22)' : 'null'},
    '4.0.0', now(), gen_random_uuid() from generate_series(1, ${SYNC}) g;
insert into public.events (id, user_id, title, date, time, tz, project, note, raw_text, location, short, created_at, updated_at)
  select gen_random_uuid(), '${uid}', pg_temp.p('evTitle', g), date '2026-01-01' + (g % 700)::int, '09:30', 'Asia/Seoul',
    pg_temp.p('project', g), pg_temp.p('evNote', g), pg_temp.p('evRaw', g), pg_temp.p('evLoc', g), nullif(pg_temp.p('short', g), ''),
    1790000000000 + g, 1790000000000 + g from generate_series(1, ${SYNC}) g;
insert into public.todos (id, user_id, title, due, project, note, raw_text, short, created_at, updated_at)
  select gen_random_uuid(), '${uid}', pg_temp.p('tdTitle', g), date '2026-01-01' + (g % 700)::int,
    pg_temp.p('project', g), pg_temp.p('tdNote', g), pg_temp.p('tdRaw', g), nullif(pg_temp.p('short', g), ''),
    1790000000000 + g, 1790000000000 + g from generate_series(1, ${SYNC}) g;
insert into public.categories (id, user_id, name, color, sort)
  select gen_random_uuid(), '${uid}', left(pg_temp.p('catName', g), greatest(${L.catName} - length(g::text), 1)) || g, '#aabbcc', g from generate_series(1, ${SYNC}) g;
insert into public.notes (id, user_id, title, body, raw_text, created_at, updated_at)
  select gen_random_uuid(), '${uid}', nullif(pg_temp.p('noteTitle', g), ''), pg_temp.p('noteBody', g), pg_temp.p('noteRaw', g),
    1790000000000 + g, 1790000000000 + g from generate_series(1, ${SYNC}) g;
create temp table nids as select id, row_number() over (order by id) rn from public.notes where user_id = '${uid}';
insert into public.note_images (id, user_id, note_id, bucket, path, bytes, width, height, ai_status, ai_desc, ai_tags)
  select x.id, '${uid}', x.nid, 'images', '${uid}/' || x.nid || '/' || x.id || '.webp', 300000, 1600, 1200, 'done',
    nullif(pg_temp.p('imgDesc', x.g), ''), ${MAX ? "array_fill('标签标签'::text, array[12])" : "array['猫','公园','晴天']"}
  from (select gen_random_uuid() id, n.id nid, g from generate_series(1, ${SYNC}) g join nids n on n.rn = 1 + (g - 1) % ${SYNC}) x;
insert into public.note_files (id, user_id, note_id, kind, path, name, mime, bytes, sha256, pages, text_excerpt, check_status, ai_status, ai_desc, ai_tags, created_at, updated_at)
  select x.id, '${uid}', x.nid, 'pdf', '${uid}/' || x.nid || '/' || x.id || '.pdf', pg_temp.p('fileName', x.g) || '.pdf', 'application/pdf', 2000000,
    encode(sha256(x.id::text::bytea), 'hex'), 12, nullif(pg_temp.p('excerpt', x.g), ''), 'ok', 'done', nullif(pg_temp.p('imgDesc', x.g), ''),
    ${MAX ? "array_fill('标签标签'::text, array[12])" : "array['合同']"}, 1790000000000 + x.g, 1790000000000 + x.g
  from (select gen_random_uuid() id, n.id nid, g from generate_series(1, ${SYNC}) g join nids n on n.rn = 1 + (g - 1) % ${SYNC}) x;
insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, year, remind_offsets, remind_time, note, created_at, updated_at)
  select gen_random_uuid(), '${uid}', 'birthday', pg_temp.p('annName', g), 'solar', 1 + g % 12, 1 + g % 28, 1990, array[0, 7]::smallint[], '09:00',
    pg_temp.p('annNote', g), 1790000000000 + g, 1790000000000 + g from generate_series(1, ${SYNC}) g;
insert into public.logs (user_id, t, device, kind, act, src, coll, item_id, fields, code)
  select '${uid}', 1790000000000 - g::bigint * 43200, ${MAX ? 'pg_temp.az(64)' : 'gen_random_uuid()::text'}, ${MAX ? 'pg_temp.az(16)' : "'run'"},
    ${MAX ? 'pg_temp.az(32)' : "'update'"}, ${MAX ? 'pg_temp.az(16)' : "'page'"}, ${MAX ? 'pg_temp.az(32)' : "'events'"}, gen_random_uuid(),
    ${MAX ? "array_fill(pg_temp.az(31), array[20])" : "array['title','date']"}, ${MAX ? 'pg_temp.az(64)' : 'null'}
  from generate_series(1, ${LOGS}) g;
select t, n from (
  select 'settings' t, count(*) n from public.settings where user_id = '${uid}' union all
  select 'devices', count(*) from public.devices where user_id = '${uid}' union all
  select 'events', count(*) from public.events where user_id = '${uid}' union all
  select 'todos', count(*) from public.todos where user_id = '${uid}' union all
  select 'categories', count(*) from public.categories where user_id = '${uid}' union all
  select 'notes', count(*) from public.notes where user_id = '${uid}' union all
  select 'note_images', count(*) from public.note_images where user_id = '${uid}' union all
  select 'note_files', count(*) from public.note_files where user_id = '${uid}' union all
  select 'anniversaries', count(*) from public.anniversaries where user_id = '${uid}' union all
  select 'logs', count(*) from public.logs where user_id = '${uid}') c;
`;
}
