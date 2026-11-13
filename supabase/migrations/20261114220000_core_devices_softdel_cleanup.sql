-- 20261114220000_core_devices_softdel_cleanup.sql：cleanup_batch 的 30 天清理多一句 devices（推进计划第一节第 8 项）
-- 原来 devices 只按“会话已不在”和“180 天没用”两条规则清，不看 deleted_at：软删的设备行最长留 180 天。
-- 软删设备行的来源（11-14 查）：
--   • 应用代码里没有写 devices.deleted_at 的路径：登记（device-reg insert）、刷新（apply_patch 只带 last_seen_at、app_version）、
--     退出登录删本机行（REST delete）、设置页移除（remove_device，硬删）、claim_endpoint（硬删占着端点的行）、两条清理规则（硬删）都不写它；
--   • 只剩通用口子：0001 给 authenticated 的 update (… deleted_at, undone) 列授权、apply_patch 的 devices 白名单含 deleted_at——
--     手工请求或以后的客户端能把本机这一行（upd 策略只许改本机会话的行）写成软删。
-- 软删后谁还读：设置页设备列表、device-reg 找本会话那一行、claim_endpoint 的占用判定、remind_due 的“有可推送设备”、my_sessions 的 orphan 判定
--   都按 deleted_at is null 过滤，软删的行等于不在；apply_patch 对它回 gone，客户端随即重新登记一行新的。
--   别的设备靠这一行自己的 deleted_at（增量拉取）已经知道它删了；硬删后 write_tombstone 照常写墓碑。没有保留的理由，
--   留着只多存推送端点和密钥（p256dh、auth）、device_secrets。所以按其他同步表的 30 天墓碑口径清，不吊销会话（软删不代表会话该下线，
--   会话还在的那台会重新登记）。D1 sync-lists 的 devices 豁免同步去掉。
-- 函数体逐字照 20261113170000，只在“会话已不在的设备行”之前多一句 devices。create or replace 保留属主和执行权。
create or replace function private.cleanup_batch(p_limit integer DEFAULT 1000) returns integer
  language plpgsql set search_path = '' as $$
declare left_ int := p_limit; k int; t0 timestamptz := clock_timestamp();
  cut30 bigint := ((extract(epoch from now()) - 30 * 86400) * 1000)::bigint;
  cut90 bigint := ((extract(epoch from now()) - 90 * 86400) * 1000)::bigint;
  r record;
begin
  -- 30 天前软删除的行（向量、vault_ai 靠外键级联；墓碑由触发器写）
  delete from public.events        where ctid in (select ctid from public.events        where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.todos         where ctid in (select ctid from public.todos         where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.todo_items    where ctid in (select ctid from public.todo_items    where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;   -- R-350
  delete from public.anniversaries where ctid in (select ctid from public.anniversaries where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.note_images   where ctid in (select ctid from public.note_images   where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.note_files    where ctid in (select ctid from public.note_files    where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.notes         where ctid in (select ctid from public.notes         where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.categories    where ctid in (select ctid from public.categories    where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  -- ai.vault、ai.enabled 不硬删（删了就回到默认值，ai.vault 的默认是打开）
  delete from public.settings      where ctid in (select ctid from public.settings      where deleted_at < cut30 and key not in ('ai.vault', 'ai.enabled') limit left_); get diagnostics k = row_count; left_ := left_ - k;
  -- 不同步的表
  delete from public.logs          where ctid in (select ctid from public.logs where t < cut90 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.applied_ops   where ctid in (select ctid from public.applied_ops where at < now() - interval '7 days' limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.tombstones    where ctid in (select ctid from public.tombstones where deleted_at < now() - interval '30 days' limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from private.pending_signups     where ctid in (select ctid from private.pending_signups where expires_at < now() limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from private.webauthn_challenges where ctid in (select ctid from private.webauthn_challenges where expires_at < now() limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from private.counters            where ctid in (select ctid from private.counters where window_start < now() - interval '30 days' limit left_); get diagnostics k = row_count; left_ := left_ - k;
  -- 30 天前软删的设备行（20261114220000）：应用里没有写 devices.deleted_at 的路径，只能经列授权或 apply_patch 白名单直接写；
  --   读设备的地方都按 deleted_at is null 过滤，软删的行没人用，却留着推送密钥和 device_secrets（级联删），按同步表的 30 天口径清；墓碑由触发器写
  delete from public.devices       where ctid in (select ctid from public.devices       where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  -- 会话已不在的设备行（session_id 为空的不碰）
  delete from public.devices d where d.ctid in (select x.ctid from public.devices x
     where x.session_id is not null and not exists (select 1 from auth.sessions s where s.id = x.session_id) limit left_);
  get diagnostics k = row_count; left_ := left_ - k;
  -- 180 天没用的设备行，先吊销会话再删
  for r in select x.id, x.user_id, x.session_id from public.devices x
            where greatest(
                    case when x.last_seen_at <= now() + interval '1 day' then x.last_seen_at end,
                    x.created_at,
                    (select max(coalesce(s.refreshed_at at time zone 'UTC', s.updated_at)) from auth.sessions s
                      where x.session_id is not null and s.id = x.session_id and s.user_id = x.user_id)
                  ) < now() - interval '180 days'
            limit left_ loop
    perform private.kill_session(r.session_id, r.user_id);
    delete from public.devices d where d.id = r.id;
    left_ := left_ - 1;
  end loop;
  -- 吊销记录按 revoked_at 留 30 天，到期并且会话已不在 auth.sessions 才删（不管明文清没清）：
  --   离线 30 天以内的丢失设备一联网还能经 session_fate 查出 revoked；
  --   会话还在的不删——session_alive 只看这张表，删了它，一个被吊销却还没从 auth.sessions 删掉的会话就又活了
  delete from private.revoked_sessions rs where rs.ctid in (select y.ctid from private.revoked_sessions y
     where y.revoked_at < now() - interval '30 days'
       and (y.session_id is null or not exists (select 1 from auth.sessions s where s.id = y.session_id))
     limit left_);
  get diagnostics k = row_count; left_ := left_ - k;
  insert into private.heartbeat (name, at, detail)
    values ('cleanup', now(), jsonb_build_object('rows', p_limit - left_, 'ms', (extract(epoch from clock_timestamp() - t0) * 1000)::int))
    on conflict (name) do update set at = excluded.at, detail = excluded.detail;
  return p_limit - left_;
end $$;
