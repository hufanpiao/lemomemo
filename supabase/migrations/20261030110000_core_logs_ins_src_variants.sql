-- B1 迁移（R259-sugg ①，安全）：logs 的 ins 策略连 'account' 的变体也挡住
-- 上一版（20261030100000_core_logs_ins_no_account_src.sql，R-259）只挡和 'account' 完全相同的写法：
--   'Account'、'account '、全角的 'ａｃｃｏｕｎｔ'、中间夹零宽空格的照样能写。客户端读“最近的导出”用 eq 精确匹配，现在无害；
--   但以后服务器要是不区分大小写、或先 trim 再读 src，这些行就能冒充 account 函数记的“导出”。
-- 做法：src 先做 NFKC 规范化（全角字母、全角空格 U+3000 变成普通的），去掉所有非字母数字的字符
--   （空格、制表、换行、零宽字符、连字符、标点都去掉），再转小写，和 'account' 比。
--   比 lower(btrim(src)) 严：btrim 只去两头的半角空格，挡不住全角空格（韩文、中文输入法常见）、制表、中间夹的零宽字符。
--   'accounts'、'account1'、'sync' 这类别的值照常能写；src 为 null 时整个表达式是 null，is distinct from 放行（客户端的 LogRow 不带 src）。
-- 原有条件一条不改（本人、账号可用）。account 函数经 service role 写 src = 'account'，绕过 RLS，不受影响。
-- 测试：supabase/tests/rls/19_logs_account_src.test.sql（行为断言、pg_policies 守门）
alter policy ins on public.logs
  with check (
    user_id = (select auth.uid()) and private.is_active()
    and lower(regexp_replace(normalize(src, NFKC), '[^[:alnum:]]', '', 'g')) is distinct from 'account'
  );
