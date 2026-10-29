// Supabase 数据库的根证书（控制台 › Project Settings › Database › SSL Configuration › Download certificate，文件名 prod-ca-2021.crt）。
// 公开证书，不是秘密，可以进仓库。B0 实测清单 P6 ⑧ 后一半用：db-probe 拿它做 ssl: { ca, rejectUnauthorized: true }。
// 现在是空的：仓库里没有这张证书、也不凭记忆抄。部署前由负责人从控制台下载，把 .crt 文件的全文（含 BEGIN / END 两行）原样贴进下面的反引号里；
// 留空时 db-probe 的 tls_ca 报 skipped_no_ca，其余步骤照跑。随 db-probe 一起删。
export const SUPABASE_ROOT_CA_PEM = ``;
