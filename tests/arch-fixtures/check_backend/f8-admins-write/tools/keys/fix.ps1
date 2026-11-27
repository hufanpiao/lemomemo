# 反例：.ps1 里的 SQL（按原文查，注释也算）
$sql = "delete from private.admins where user_id = '00000000-0000-0000-0000-000000000000';"
$ok = "select count(*) from private.admins;"
