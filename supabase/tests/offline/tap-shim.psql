-- 离线检查用的 pgTAP 替身：只实现测试里用到的 plan、ok、is、isnt、finish，输出格式同 pgTAP（“ok N - …” / “not ok N - …”）
-- 真库上用 supabase test db 自带的 pgTAP，这个文件不进迁移

create function extensions.plan(n int) returns text language plpgsql as $$
begin
  perform set_config('tap.planned', n::text, true);
  perform set_config('tap.run', '0', true);
  perform set_config('tap.failed', '0', true);
  return '1..' || n;
end $$;

create function extensions.ok(pass boolean, descr text default '') returns text language plpgsql as $$
declare n int := coalesce(nullif(current_setting('tap.run', true), ''), '0')::int + 1;
begin
  perform set_config('tap.run', n::text, true);
  if coalesce(pass, false) then return 'ok ' || n || ' - ' || descr; end if;
  perform set_config('tap.failed', (coalesce(nullif(current_setting('tap.failed', true), ''), '0')::int + 1)::text, true);
  return 'not ok ' || n || ' - ' || descr;
end $$;

create function extensions.is(have anyelement, want anyelement, descr text default '') returns text language plpgsql as $$
declare r text := extensions.ok(have is not distinct from want, descr);
begin
  if r like 'not ok%' then
    r := r || E'\n#         have: ' || coalesce(have::text, 'NULL') || E'\n#         want: ' || coalesce(want::text, 'NULL');
  end if;
  return r;
end $$;

create function extensions.isnt(have anyelement, want anyelement, descr text default '') returns text language plpgsql as $$
begin
  return extensions.ok(have is distinct from want, descr || ' (have: ' || coalesce(have::text, 'NULL') || ')');
end $$;

create function extensions.finish() returns setof text language plpgsql as $$
declare planned int := coalesce(nullif(current_setting('tap.planned', true), ''), '0')::int;
  run int := coalesce(nullif(current_setting('tap.run', true), ''), '0')::int;
  failed int := coalesce(nullif(current_setting('tap.failed', true), ''), '0')::int;
begin
  if run <> planned then return next '# Looks like you planned ' || planned || ' tests but ran ' || run; end if;
  if failed > 0 then return next '# Looks like you failed ' || failed || ' test of ' || run; end if;
  return;
end $$;

grant execute on all functions in schema extensions to public;
