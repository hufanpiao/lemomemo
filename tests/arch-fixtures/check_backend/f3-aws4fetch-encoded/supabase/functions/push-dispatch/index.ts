// 违规 F3（B1 接手清单 S3）：esm.sh 的写法变体引 aws4fetch——/* 前缀（外部依赖）、百分号编码、?deps= 里用 + 分隔
import 'https://esm.sh/*aws4fetch@1.0.20';
import 'https://esm.sh/%61ws4fetch@1.0.20';
import 'https://esm.sh/some-pkg@1?deps=foo@1+aws4fetch@1.0.20';
import 'https://esm.sh/v135/aws4fetch@1.0.20/es2022/aws4fetch.mjs';
