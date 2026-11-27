-- expect: system_cols 和清单不一致
-- TC-B0-24 / 0.27：table_meta 和清单的 systemCols 对不上
update private.table_meta set system_cols = system_cols || '{title}' where tbl = 'events';
