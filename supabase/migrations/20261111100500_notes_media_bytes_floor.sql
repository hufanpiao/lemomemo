-- B4 迁移：三列字节数加下限（S10 安全审 M1；部署第一步，和 20261111100000 一起上）
-- 只新建，不改旧迁移。原来 note_images.bytes、note_files.bytes、anniversaries.avatar_bytes 只有上限（0003、0004、0005），
--   负数能写进去，存储额度合计时会抵掉别的行的占用（authenticated 能直接改 anniversaries.avatar_bytes，0005 的列级授权）。
--   额度公式本身已经每项 greatest(x, 0)（20261111100000），这里再从约束上堵住。
-- 下限：bytes ≥ 1（空文件不让写行，客户端本来也不会传 0 字节的图和附件）；avatar_bytes 为 null 或 ≥ 1（和 avatar_id 同时为空的约束不变）。
-- 做法：先 not valid（只管以后写的行，加的时候不扫全表、不长时间锁表），再 validate（扫一遍旧行，只拿 share update exclusive 锁，不挡读写）。
--   validate 报错说明库里已经有不合下限的旧行：先查出来（select … where bytes < 1 / avatar_bytes < 1）按情况改或删，再推这一份。

-- 先数不合下限的旧行，有就整份停下并报出各表条数（不然 validate 只报一句约束名，看不出是哪张表、有几行）
do $$
declare a bigint; b bigint; c bigint;
begin
  select count(*) into a from public.note_images where bytes < 1;
  select count(*) into b from public.note_files where bytes < 1;
  select count(*) into c from public.anniversaries where avatar_bytes < 1;
  if a + b + c > 0 then
    raise exception 'media_bytes_floor: 有不合下限的旧行：note_images % 行、note_files % 行、anniversaries % 行，先查清再改或删（上线手册第三节“每人存储上限”的预检）', a, b, c;
  end if;
end $$;

alter table public.note_images   add constraint note_images_bytes_min     check (bytes >= 1) not valid;
alter table public.note_files    add constraint note_files_bytes_min      check (bytes >= 1) not valid;
alter table public.anniversaries add constraint anniversaries_avatar_bytes_min check (avatar_bytes is null or avatar_bytes >= 1) not valid;

alter table public.note_images   validate constraint note_images_bytes_min;
alter table public.note_files    validate constraint note_files_bytes_min;
alter table public.anniversaries validate constraint anniversaries_avatar_bytes_min;
